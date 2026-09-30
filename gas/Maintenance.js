/**
 * งานบำรุงรักษา (ตั้งเวลาด้วย installTriggers)
 *
 * รายชั่วโมง: ตรึงกลุ่มที่ถึงวันปิดจัดกลุ่ม, ย้ายไฟล์ที่ส่งแล้วแต่ยังค้างใน staging
 * รายวัน    : ล้างไฟล์ฉบับร่างกำพร้า, ล้างไฟล์ที่ถูกกักเกินกำหนด, สำรองฐานข้อมูล,
 *             คำนวณพื้นที่ใช้งาน, แจ้งเตือนพื้นที่ใกล้เต็ม, ลบ journal เก่า
 */
var Maintenance = {
  hourly: function () {
    var frozen = 0;
    Db.all('assignment_group_sets').forEach(function (gs) {
      if (gs.formation_close_at && Util.nowIso() > gs.formation_close_at && !gs.all_frozen_at) {
        Db.tx('maint.freeze', function (tx) { if (Groups.freezeSetIfClosed(tx, gs)) frozen++; });
      }
    });
    var moved = Maintenance.moveStoredFromStaging();
    return { frozenSets: frozen, moved: moved };
  },

  daily: function () {
    var out = {};
    out.staging = Maintenance.cleanupStaging();
    out.quarantine = Maintenance.cleanupQuarantine();
    out.backup = Maintenance.backup();
    out.usage = Maintenance.recomputeUsage();
    out.journal = Db._pruneTechnical('tx_journal', new Date(Date.now() - APP.JOURNAL_KEEP_DAYS * 86400000).toISOString());
    Audit.system('maintenance.daily', 'system', '', out);
    return out;
  },

  /** คิวไฟล์ที่ย้ายออกจาก staging ไม่สำเร็จตอนส่งงาน (เก็บใน Script Properties จำกัด 500 รายการ) */
  queueMove: function (driveId, offeringId, assessmentId) {
    var p = PropertiesService.getScriptProperties();
    var q = JSON.parse(p.getProperty('PENDING_MOVES') || '[]');
    q.push({ d: driveId, o: offeringId, a: assessmentId });
    p.setProperty('PENDING_MOVES', JSON.stringify(q.slice(-500)));
  },

  moveStoredFromStaging: function () {
    var p = PropertiesService.getScriptProperties();
    var q = JSON.parse(p.getProperty('PENDING_MOVES') || '[]');
    var left = [];
    var moved = 0;
    q.forEach(function (item) {
      try {
        var a = Db.get('assessments', item.a);
        var off = Db.get('course_offerings', item.o);
        DriveStore.move(item.d, DriveStore.assessmentFolderId(off, a));
        moved++;
      } catch (e) {
        console.warn('move retry failed ' + item.d + ': ' + e);
        left.push(item);
      }
    });
    p.setProperty('PENDING_MOVES', JSON.stringify(left));
    return moved;
  },

  /**
   * ล้างไฟล์ staging:
   * - ไม่มีฉบับร่างอ้างอิง (ถูกลบออกจากร่าง/อัปโหลดแล้วทิ้ง) และเก่ากว่า staging_retention_hours
   * - อยู่ในฉบับร่างของงานที่ปิดรับไปแล้วเกิน staging_retention_hours
   * ไฟล์ถูกย้ายไปถังขยะของ Drive (กู้คืนได้ 30 วัน) และบันทึก state=trashed
   */
  cleanupStaging: function () {
    var count = 0;
    var schools = Db.all('schools');
    var settingsBySchool = {};
    schools.forEach(function (s) { settingsBySchool[s.id] = Settings.get(s.id); });
    var now = Date.now();
    var candidates = Db.find('file_assets', { state: 'staging' });
    candidates.forEach(function (f) {
      var st = settingsBySchool[f.school_id] || APP.DEFAULT_SETTINGS;
      var cutoff = now - st.staging_retention_hours * 3600000;
      if (Util.ms(f.created_at) > cutoff) return;
      var refs = Db.find('submission_files', { file_asset_id: f.id });
      if (refs.some(function (r) { return r.state === 'submitted'; })) return;
      var drafts = refs.filter(function (r) { return r.state === 'draft'; });
      if (drafts.length) {
        var a = Db.get('assessments', f.assessment_id);
        var closeAt = a ? (a.allow_late ? a.close_at : (a.due_at || a.close_at)) : '';
        if (!closeAt || Util.ms(closeAt) > cutoff) return;
      }
      try {
        Db.tx('maint.stagingCleanup', function (tx) {
          var fresh = tx.get('file_assets', f.id);
          if (fresh.state !== 'staging') return;
          if (tx.find('submission_files', { file_asset_id: f.id }).some(function (r) { return r.state === 'submitted'; })) return;
          tx.find('submission_files', { file_asset_id: f.id }).forEach(function (r) {
            if (r.state === 'draft') tx.update('submission_files', r.id, { state: 'removed' });
          });
          tx.update('file_assets', f.id, { state: 'trashed', trashed_at: tx.now });
          tx.afterCommit(function () { try { DriveStore.trash(f.drive_file_id); } catch (e) { console.warn(e); } });
          count++;
        });
      } catch (e) { console.warn('cleanup ' + f.id + ': ' + e); }
    });
    return count;
  },

  cleanupQuarantine: function () {
    var count = 0;
    Db.find('file_assets', { state: 'quarantined' }).forEach(function (f) {
      var st = Settings.get(f.school_id);
      if (Util.ms(f.created_at) > Date.now() - st.quarantine_retention_days * 86400000) return;
      Db.tx('maint.quarantine', function (tx) { tx.update('file_assets', f.id, { state: 'trashed', trashed_at: tx.now }); });
      try { DriveStore.trash(f.drive_file_id); } catch (e) { console.warn(e); }
      count++;
    });
    return count;
  },

  /**
   * สำรองฐานข้อมูล: คัดลอกไฟล์ Sheets ทุกกลุ่มไปโฟลเดอร์ 08_backups/<วันที่-เวลา>
   * ไฟล์งานไม่ถูกคัดลอกซ้ำ (อยู่ใน Drive และอ้างอิงด้วย drive_file_id) — ดูขั้นตอนกู้คืนใน docs/06-deployment.md
   */
  backup: function () {
    var p = PropertiesService.getScriptProperties();
    var root = DriveApp.getFolderById(DriveStore.folderId('BACKUPS'));
    var stamp = Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd_HHmmss');
    var folder = root.createFolder(stamp);
    var copies = Object.keys(APP.DB_GROUPS).map(function (db) {
      var id = p.getProperty('DB_' + db.toUpperCase());
      var copy = DriveApp.getFileById(id).makeCopy(APP.DB_GROUPS[db] + ' ' + stamp, folder);
      return { db: db, id: copy.getId() };
    });
    folder.createFile(Utilities.newBlob(JSON.stringify({
      createdAt: new Date().toISOString(), schemaVersion: APP.SCHEMA_VERSION, databases: copies,
      folders: Object.keys(APP.DRIVE_FOLDERS).reduce(function (o, k) { o[k] = p.getProperty('FOLDER_' + k); return o; }, {})
    }, null, 2), 'application/json', 'manifest.json'));
    // ลบชุดสำรองที่เก่ากว่ากำหนด
    var schools = Db.all('schools');
    var keepDays = schools.length ? Settings.get(schools[0].id).backup_retention_days : APP.DEFAULT_SETTINGS.backup_retention_days;
    var cutoff = Utilities.formatDate(new Date(Date.now() - keepDays * 86400000), APP.TIMEZONE, 'yyyy-MM-dd');
    var it = root.getFolders();
    var removed = 0;
    while (it.hasNext()) {
      var f = it.next();
      if (/^\d{4}-\d{2}-\d{2}_/.test(f.getName()) && f.getName().slice(0, 10) < cutoff) { f.setTrashed(true); removed++; }
    }
    return { folder: stamp, copies: copies.length, removedOld: removed };
  },

  recomputeUsage: function () {
    var total = 0;
    Db.all('file_assets').forEach(function (f) {
      if (['staging', 'stored', 'quarantined'].indexOf(f.state) >= 0) total += Number(f.size_bytes || 0);
    });
    PropertiesService.getScriptProperties().setProperty('USAGE_BYTES', String(total));
    var drive = DriveStore.usage();
    var schools = Db.all('schools');
    if (schools.length && drive.limit > 0) {
      var st = Settings.get(schools[0].id);
      var pct = drive.used / drive.limit * 100;
      if (pct >= st.quota_warn_percent) {
        var admins = Db.all('role_assignments').filter(function (r) { return r.role === 'admin' && !r.revoked_at; }).map(function (r) { return r.user_id; });
        Notify.sendMany(admins, 'storage_warning', 'พื้นที่ Google Drive ใกล้เต็ม', 'ใช้ไปแล้ว ' + pct.toFixed(1) + '%', 'admin');
      }
    }
    return { appBytes: total, driveUsed: drive.used, driveLimit: drive.limit };
  },

  status: function (ctx) {
    Authz.requireAdmin(ctx);
    var p = PropertiesService.getScriptProperties();
    var drive = DriveStore.usage();
    var settings = Settings.get(ctx.schoolId);
    var byState = {};
    Db.all('file_assets').forEach(function (f) {
      if (f.school_id !== ctx.schoolId) return;
      var b = byState[f.state] = byState[f.state] || { count: 0, bytes: 0 };
      b.count++;
      b.bytes += Number(f.size_bytes || 0);
    });
    return {
      env: p.getProperty('ENV') || '',
      setup: Setup.status(),
      drive: drive,
      appUsageBytes: Number(p.getProperty('USAGE_BYTES') || 0),
      files: byState,
      settings: settings,
      triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
      pendingTx: !!p.getProperty('TX_PENDING'),
      counts: {
        students: Db.all('students').filter(function (s) { return s.school_id === ctx.schoolId; }).length,
        teachers: Db.all('teachers').filter(function (s) { return s.school_id === ctx.schoolId; }).length,
        offerings: Db.all('course_offerings').filter(function (s) { return s.school_id === ctx.schoolId; }).length
      }
    };
  }
};
