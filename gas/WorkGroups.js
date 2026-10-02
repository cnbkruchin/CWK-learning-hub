/**
 * กลุ่มประจำรายวิชา (กลุ่มเดิมทำงานกลุ่มได้หลายงาน)
 *
 * - ครู/ผู้ดูแลสร้างกลุ่ม เลือกนักเรียนที่ลงทะเบียนแล้วเข้ากลุ่ม ย้าย ตั้งหัวหน้า สุ่มจัดกลุ่ม และล็อกกลุ่มได้
 * - นักเรียนสร้างกลุ่ม (เป็นหัวหน้า) แล้วหัวหน้าเลือกสมาชิกจากรายชื่อเพื่อนที่ยังไม่มีกลุ่ม
 *   ค่าเริ่มต้นส่งคำเชิญให้เพื่อนตอบรับ (สมาชิกยืนยันเอง) ครูเปิดให้หัวหน้าเพิ่มสมาชิกทันทีได้
 * - หนึ่งคนอยู่ได้หนึ่งกลุ่มต่อรายวิชา และต้องลงทะเบียนในรายวิชานั้น (ตรวจภายใต้ล็อก)
 * - งานกลุ่มที่ตั้งค่า "ใช้กลุ่มประจำรายวิชา" จะมีกลุ่มของงาน (groups) ที่ผูกกับกลุ่มประจำรายวิชาและซิงก์สมาชิกอัตโนมัติ
 *   จนกว่ากลุ่มของงานนั้นจะถูกตรึง (ส่งงานครั้งแรก/ปิดจัดกลุ่ม/ครูให้คะแนน) หลังตรึงการเปลี่ยนกลุ่มประจำรายวิชา
 *   ไม่ย้อนกลับไปแก้รายชื่อหรือคะแนนของงานเดิม คะแนนกลุ่มของแต่ละงานจึงอยู่กับกลุ่มของงานนั้นเสมอ
 */
var WorkGroups = {
  _hist: function (tx, ctx, wgId, studentId, action, reason, detail) {
    var row = { work_group_id: wgId, student_id: studentId || '', action: action, reason: reason || '', detail_json: detail || null };
    tx.afterCommit(function () { try { Db.append('work_group_history', row, ctx && ctx.user ? ctx.user.id : ''); } catch (e) { console.error(e); } });
  },

  _activeEnrolled: function (finder, offeringId) {
    var m = {};
    finder.find('enrollments', { offering_id: offeringId }).forEach(function (e) { if (e.status === 'active') m[e.student_id] = e; });
    return m;
  },

  _studentBrief: function (sid, leaderId) {
    var s = Db.get('students', sid);
    return s ? { studentId: s.id, code: s.student_code, name: Registry.personName(s), roomLabel: Registry.roomLabel(s.class_level, s.room), isLeader: leaderId === s.id } : null;
  },

  _recount: function (tx, wgId) {
    var n = tx.find('work_group_members', { work_group_id: wgId, status: 'active' }).length;
    tx.update('work_groups', wgId, { active_count: n });
    return n;
  },

  /** หลังสมาชิกออก: ตั้งหัวหน้าใหม่หรือยุบกลุ่มเมื่อไม่มีสมาชิก */
  _afterLeave: function (tx, ctx, wg, studentId) {
    var n = WorkGroups._recount(tx, wg.id);
    var patch = {};
    if (n === 0) {
      patch.status = 'disbanded';
      tx.find('work_group_members', { work_group_id: wg.id }).forEach(function (m) {
        if (m.status === 'invited') tx.update('work_group_members', m.id, { status: 'cancelled', responded_at: tx.now });
      });
      WorkGroups._hist(tx, ctx, wg.id, '', 'disband', 'ไม่มีสมาชิก');
    } else if (wg.leader_student_id === studentId) {
      patch.leader_student_id = tx.find('work_group_members', { work_group_id: wg.id, status: 'active' })[0].student_id;
    }
    if (Object.keys(patch).length) tx.update('work_groups', wg.id, patch);
  },

  _cancelInvites: function (tx, offeringId, studentId) {
    tx.find('work_group_members', { offering_id: offeringId, student_id: studentId }).forEach(function (m) {
      if (m.status === 'invited') tx.update('work_group_members', m.id, { status: 'cancelled', responded_at: tx.now });
    });
  },

  /** ย้ายนักเรียนเข้ากลุ่ม (ออกจากกลุ่มเดิมถ้ามี) คืนรายการกลุ่มที่เปลี่ยน */
  _place: function (tx, ctx, offeringId, wg, studentId, action) {
    var touched = [wg.id];
    var cur = tx.find('work_group_members', { offering_id: offeringId, student_id: studentId, status: 'active' })[0];
    if (cur && cur.work_group_id === wg.id) return touched;
    if (cur) {
      tx.update('work_group_members', cur.id, { status: 'removed', responded_at: tx.now });
      var old = tx.get('work_groups', cur.work_group_id);
      WorkGroups._hist(tx, ctx, old.id, studentId, 'remove', 'ย้ายไปกลุ่ม ' + wg.name);
      WorkGroups._afterLeave(tx, ctx, old, studentId);
      touched.push(old.id);
    }
    WorkGroups._cancelInvites(tx, offeringId, studentId);
    tx.insert('work_group_members', { work_group_id: wg.id, offering_id: offeringId, student_id: studentId, status: 'active', added_by_user_id: ctx.user.id, responded_at: tx.now });
    WorkGroups._recount(tx, wg.id);
    if (!tx.get('work_groups', wg.id).leader_student_id) tx.update('work_groups', wg.id, { leader_student_id: studentId });
    WorkGroups._hist(tx, ctx, wg.id, studentId, action || 'add', '');
    return touched;
  },

  // ---------------------------------------------------------------- ซิงก์ไปยังกลุ่มของงาน
  /**
   * ซิงก์กลุ่มประจำรายวิชาไปยังกลุ่มของงานกลุ่มทุกงานที่ใช้กลุ่มประจำรายวิชา (เฉพาะกลุ่มของงานที่ยังไม่ตรึง)
   * @param {string[]=} onlyIds ซิงก์เฉพาะกลุ่มประจำรายวิชาเหล่านี้ (ไม่ระบุ = ทั้งหมด)
   */
  syncOffering: function (tx, offeringId, onlyIds, ctx) {
    var sets = tx.find('assignment_group_sets', { offering_id: offeringId }).filter(function (s) { return s.source === 'work_groups'; });
    if (!sets.length) return 0;
    var wgs = tx.find('work_groups', { offering_id: offeringId });
    var enrolled = WorkGroups._activeEnrolled(tx, offeringId);
    var desired = {};
    var activeWg = {};
    wgs.forEach(function (w) { if (w.status === 'active') activeWg[w.id] = true; });
    tx.find('work_group_members', { offering_id: offeringId }).forEach(function (m) {
      if (m.status === 'active' && activeWg[m.work_group_id] && enrolled[m.student_id]) desired[m.student_id] = m.work_group_id;
    });
    var n = 0;
    sets.forEach(function (gs) {
      var a = tx.get('assessments', gs.assessment_id);
      if (!a || a.status === 'archived') return;
      n += WorkGroups._syncSet(tx, gs, wgs, desired, onlyIds, ctx);
    });
    return n;
  },

  _syncSet: function (tx, gs, wgs, desired, onlyIds, ctx) {
    var actor = ctx && ctx.user ? ctx.user.id : '';
    var groups = tx.find('groups', { group_set_id: gs.id });
    var byWg = {};
    groups.forEach(function (g) { if (g.work_group_id && (!byWg[g.work_group_id] || byWg[g.work_group_id].status === 'disbanded')) byWg[g.work_group_id] = g; });
    var frozenGroup = {};
    groups.forEach(function (g) { if (g.frozen_at) frozenGroup[g.id] = true; });
    var mships = tx.find('group_memberships', { group_set_id: gs.id }).filter(function (m) { return m.status === 'active'; });
    var lockedStudent = {};
    mships.forEach(function (m) { if (frozenGroup[m.group_id]) lockedStudent[m.student_id] = true; });
    var touched = {};
    var changes = 0;
    wgs.forEach(function (wg) {
      if (onlyIds && onlyIds.indexOf(wg.id) < 0) return;
      var g = byWg[wg.id];
      if (wg.status !== 'active') {
        if (g && !g.frozen_at && g.status !== 'disbanded') {
          mships.forEach(function (m) {
            if (m.group_id === g.id && m.status === 'active') { tx.update('group_memberships', m.id, { status: 'removed', responded_at: tx.now }); changes++; }
          });
          tx.update('groups', g.id, { status: 'disbanded', active_count: 0 });
        }
        return;
      }
      if (!g) {
        g = tx.insert('groups', {
          group_set_id: gs.id, assessment_id: gs.assessment_id, offering_id: gs.offering_id, name: wg.name,
          leader_student_id: wg.leader_student_id, status: 'approved', active_count: 0, work_group_id: wg.id
        });
        byWg[wg.id] = g;
        changes++;
      }
      if (g.frozen_at) return;
      var want = Object.keys(desired).filter(function (sid) { return desired[sid] === wg.id && !lockedStudent[sid]; });
      mships.forEach(function (m) {
        if (m.group_id === g.id && m.status === 'active' && want.indexOf(m.student_id) < 0) {
          tx.update('group_memberships', m.id, { status: 'removed', responded_at: tx.now });
          touched[g.id] = true; changes++;
        }
      });
      want.forEach(function (sid) {
        var cur = mships.filter(function (m) { return m.student_id === sid && m.status === 'active'; });
        if (cur.some(function (m) { return m.group_id === g.id; })) return;
        cur.forEach(function (m) {
          tx.update('group_memberships', m.id, { status: 'removed', responded_at: tx.now });
          touched[m.group_id] = true;
        });
        mships.push(tx.insert('group_memberships', { group_set_id: gs.id, group_id: g.id, student_id: sid, status: 'active', invited_by_user_id: actor, responded_at: tx.now }));
        touched[g.id] = true; changes++;
      });
      var patch = {};
      if (g.status === 'disbanded') patch.status = 'approved';
      if (g.name !== wg.name) patch.name = wg.name;
      var leader = want.indexOf(wg.leader_student_id) >= 0 ? wg.leader_student_id : (want[0] || '');
      if (g.leader_student_id !== leader) patch.leader_student_id = leader;
      if (Object.keys(patch).length) tx.update('groups', g.id, patch);
      touched[g.id] = true;
    });
    Object.keys(touched).forEach(function (gid) {
      var g = tx.get('groups', gid);
      if (g.frozen_at) return;
      var cnt = Groups.recount(tx, gid);
      if (cnt === 0 && !g.work_group_id && g.status !== 'disbanded') tx.update('groups', gid, { status: 'disbanded' });
    });
    return changes;
  },

  /** เรียกเมื่อถอนนักเรียนออกจากรายวิชา */
  onWithdraw: function (tx, ctx, offeringId, studentId) {
    var touched = [];
    tx.find('work_group_members', { offering_id: offeringId, student_id: studentId }).forEach(function (m) {
      if (m.status === 'invited') tx.update('work_group_members', m.id, { status: 'cancelled', responded_at: tx.now });
      if (m.status === 'active') {
        tx.update('work_group_members', m.id, { status: 'removed', responded_at: tx.now });
        var wg = tx.get('work_groups', m.work_group_id);
        WorkGroups._hist(tx, ctx, wg.id, studentId, 'remove', 'ถอนรายวิชา');
        WorkGroups._afterLeave(tx, ctx, wg, studentId);
        touched.push(wg.id);
      }
    });
    if (touched.length) WorkGroups.syncOffering(tx, offeringId, touched, ctx);
  },

  // ---------------------------------------------------------------- ครู / ผู้ดูแล
  overview: function (ctx, offeringId) {
    var auth = Authz.requireOffering(ctx, offeringId, 'can_view');
    var o = auth.offering;
    var enrolled = WorkGroups._activeEnrolled(Db, o.id);
    var mems = Db.find('work_group_members', { offering_id: o.id });
    var grouped = {};
    var groups = Db.find('work_groups', { offering_id: o.id }).filter(function (w) { return w.status === 'active'; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'th', { numeric: true }); })
      .map(function (w) {
        var active = mems.filter(function (m) { return m.work_group_id === w.id && m.status === 'active'; });
        active.forEach(function (m) { grouped[m.student_id] = true; });
        return {
          id: w.id, version: w.version, name: w.name, leaderStudentId: w.leader_student_id, note: w.note,
          members: active.map(function (m) { var b = WorkGroups._studentBrief(m.student_id, w.leader_student_id); if (b) b.enrolled = !!enrolled[m.student_id]; return b; }).filter(Boolean),
          invited: mems.filter(function (m) { return m.work_group_id === w.id && m.status === 'invited'; }).map(function (m) { return WorkGroups._studentBrief(m.student_id, ''); }).filter(Boolean)
        };
      });
    groups.forEach(function (g) { g.count = g.members.length; });
    var ungrouped = Object.keys(enrolled).filter(function (sid) { return !grouped[sid]; })
      .map(function (sid) { return Db.get('students', sid); }).filter(Boolean).sort(Registry.compareStudents)
      .map(function (s) { return WorkGroups._studentBrief(s.id, ''); });
    var sets = Util.indexBy(Db.find('assignment_group_sets', { offering_id: o.id }), 'assessment_id');
    var groupAssessments = Db.find('assessments', { offering_id: o.id }).filter(function (a) {
      return a.kind === 'group' && a.status !== 'archived' && sets[a.id] && sets[a.id].source === 'work_groups';
    }).map(function (a) { return { id: a.id, code: a.code, title: a.title, status: a.status }; });
    return {
      offering: Courses.offeringDto(ctx, o, auth.perms),
      settings: { maxSize: Number(o.group_max_size || 0), leaderDirectAdd: !!o.leader_direct_add, locked: !!o.groups_locked },
      groups: groups, ungrouped: ungrouped, groupAssessments: groupAssessments,
      canManage: !!auth.perms.can_manage
    };
  },

  saveSettings: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var max = Number(req.maxSize || 0);
    if (!(max >= 0 && max <= 50) || Math.floor(max) !== max) Errors.raise('VALIDATION', 'จำนวนสมาชิกสูงสุดต้องเป็น 0–50 (0 = ไม่จำกัด)');
    return Db.tx('wg.settings', function (tx) {
      var o = tx.update('course_offerings', auth.offering.id, { group_max_size: max, leader_direct_add: !!req.leaderDirectAdd, groups_locked: !!req.locked });
      tx.afterCommit(function () { Audit.log(ctx, 'wg.settings', 'course_offerings', o.id, { max: max, direct: !!req.leaderDirectAdd, locked: !!req.locked }, '', o.id); });
      return { maxSize: max, leaderDirectAdd: !!req.leaderDirectAdd, locked: !!req.locked };
    }, { actorId: ctx.user.id });
  },

  /** สร้าง/แก้กลุ่ม (ชื่อ หัวหน้า) และใส่สมาชิกเริ่มต้นได้ */
  save: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var name = Util.requireStr(req.name, 'ชื่อกลุ่ม', 100);
    return Db.tx('wg.save', function (tx) {
      var enrolled = WorkGroups._activeEnrolled(tx, auth.offering.id);
      var dup = tx.find('work_groups', { offering_id: auth.offering.id }).filter(function (w) { return w.status === 'active' && w.name === name && w.id !== req.id; });
      if (dup.length) Errors.raise('DUPLICATE', 'มีกลุ่มชื่อนี้แล้ว');
      var wg, touched = [];
      if (req.id) {
        wg = tx.get('work_groups', req.id);
        if (!wg || wg.offering_id !== auth.offering.id || wg.status !== 'active') Errors.raise('NOT_FOUND');
        var patch = { name: name, note: Util.str(req.note, 500) };
        if (req.leaderStudentId !== undefined && req.leaderStudentId !== wg.leader_student_id) {
          var isMember = tx.find('work_group_members', { work_group_id: wg.id, student_id: req.leaderStudentId, status: 'active' }).length;
          if (!isMember) Errors.raise('VALIDATION', 'หัวหน้ากลุ่มต้องเป็นสมาชิกของกลุ่ม');
          patch.leader_student_id = req.leaderStudentId;
          WorkGroups._hist(tx, ctx, wg.id, req.leaderStudentId, 'leader', '');
        }
        wg = tx.update('work_groups', wg.id, patch, { expectedVersion: req.version });
        if (patch.name !== undefined) WorkGroups._hist(tx, ctx, wg.id, '', 'rename', '', { name: name });
        touched.push(wg.id);
      } else {
        wg = tx.insert('work_groups', { offering_id: auth.offering.id, name: name, status: 'active', active_count: 0, note: Util.str(req.note, 500) });
        WorkGroups._hist(tx, ctx, wg.id, '', 'create', '');
        touched.push(wg.id);
      }
      (req.studentIds || []).forEach(function (sid) {
        if (!enrolled[sid]) Errors.raise('VALIDATION', 'มีนักเรียนที่ไม่ได้ลงทะเบียนในรายวิชานี้');
        touched = touched.concat(WorkGroups._place(tx, ctx, auth.offering.id, wg, sid, 'add'));
      });
      if (req.leaderStudentId && !req.id) {
        if (!tx.find('work_group_members', { work_group_id: wg.id, student_id: req.leaderStudentId, status: 'active' }).length) Errors.raise('VALIDATION', 'หัวหน้ากลุ่มต้องเป็นสมาชิกของกลุ่ม');
        tx.update('work_groups', wg.id, { leader_student_id: req.leaderStudentId });
      }
      WorkGroups.syncOffering(tx, auth.offering.id, touched, ctx);
      return { id: wg.id };
    }, { actorId: ctx.user.id });
  },

  /** ครู/ผู้ดูแลเพิ่มนักเรียนเข้ากลุ่มโดยตรง (ย้ายออกจากกลุ่มเดิมถ้ามี) */
  addMembers: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var ids = (req.studentIds || []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!ids.length) Errors.raise('VALIDATION', 'กรุณาเลือกนักเรียน');
    return Db.tx('wg.addMembers', function (tx) {
      var wg = tx.get('work_groups', req.workGroupId);
      if (!wg || wg.offering_id !== auth.offering.id || wg.status !== 'active') Errors.raise('NOT_FOUND');
      var enrolled = WorkGroups._activeEnrolled(tx, auth.offering.id);
      var touched = [];
      var moved = 0;
      ids.forEach(function (sid) {
        if (!enrolled[sid]) Errors.raise('VALIDATION', 'มีนักเรียนที่ไม่ได้ลงทะเบียนในรายวิชานี้');
        var before = tx.find('work_group_members', { offering_id: auth.offering.id, student_id: sid, status: 'active' })[0];
        if (before && before.work_group_id !== wg.id) moved++;
        touched = touched.concat(WorkGroups._place(tx, ctx, auth.offering.id, wg, sid, 'add'));
      });
      var count = tx.find('work_group_members', { work_group_id: wg.id, status: 'active' }).length;
      var max = Number(auth.offering.group_max_size || 0);
      WorkGroups.syncOffering(tx, auth.offering.id, touched, ctx);
      tx.afterCommit(function () { Audit.log(ctx, 'wg.addMembers', 'work_groups', wg.id, { students: ids, moved: moved }, '', auth.offering.id); });
      return { count: count, moved: moved, overMax: !!(max && count > max) };
    }, { actorId: ctx.user.id });
  },

  removeMember: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    return Db.tx('wg.removeMember', function (tx) {
      var wg = tx.get('work_groups', req.workGroupId);
      if (!wg || wg.offering_id !== auth.offering.id) Errors.raise('NOT_FOUND');
      var m = tx.find('work_group_members', { work_group_id: wg.id, student_id: req.studentId }).filter(function (x) { return x.status === 'active' || x.status === 'invited'; })[0];
      if (!m) Errors.raise('NOT_FOUND');
      tx.update('work_group_members', m.id, { status: m.status === 'invited' ? 'cancelled' : 'removed', responded_at: tx.now });
      if (m.status === 'active') {
        WorkGroups._hist(tx, ctx, wg.id, req.studentId, 'remove', Util.str(req.reason, 500));
        WorkGroups._afterLeave(tx, ctx, wg, req.studentId);
        WorkGroups.syncOffering(tx, auth.offering.id, [wg.id], ctx);
      }
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  disband: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    return Db.tx('wg.disband', function (tx) {
      var wg = tx.get('work_groups', req.workGroupId);
      if (!wg || wg.offering_id !== auth.offering.id) Errors.raise('NOT_FOUND');
      tx.find('work_group_members', { work_group_id: wg.id }).forEach(function (m) {
        if (m.status === 'active') tx.update('work_group_members', m.id, { status: 'removed', responded_at: tx.now });
        if (m.status === 'invited') tx.update('work_group_members', m.id, { status: 'cancelled', responded_at: tx.now });
      });
      tx.update('work_groups', wg.id, { status: 'disbanded', active_count: 0 });
      WorkGroups._hist(tx, ctx, wg.id, '', 'disband', Util.str(req.reason, 500));
      WorkGroups.syncOffering(tx, auth.offering.id, [wg.id], ctx);
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  /** สุ่มจัดนักเรียนที่ยังไม่มีกลุ่มเป็นกลุ่มละ size คน (แยกตามห้องได้) */
  autoGroup: function (ctx, req) {
    var auth = Authz.requireOffering(ctx, req.offeringId, 'can_manage');
    var size = Number(req.size);
    if (!(size >= 1 && size <= 50) || Math.floor(size) !== size) Errors.raise('VALIDATION', 'จำนวนสมาชิกต่อกลุ่มต้องเป็น 1–50');
    return Db.tx('wg.auto', function (tx) {
      var enrolled = WorkGroups._activeEnrolled(tx, auth.offering.id);
      var grouped = {};
      tx.find('work_group_members', { offering_id: auth.offering.id }).forEach(function (m) { if (m.status === 'active') grouped[m.student_id] = true; });
      var pool = Object.keys(enrolled).filter(function (sid) { return !grouped[sid]; }).map(function (sid) { return tx.get('students', sid); });
      var buckets = {};
      pool.forEach(function (s) { var k = req.byRoom ? Registry.roomLabel(s.class_level, s.room) : '*'; (buckets[k] = buckets[k] || []).push(s); });
      var existing = tx.find('work_groups', { offering_id: auth.offering.id }).filter(function (w) { return w.status === 'active'; });
      var names = existing.map(function (w) { return w.name; });
      var seq = existing.length;
      var created = [];
      Object.keys(buckets).sort().forEach(function (k) {
        var list = buckets[k];
        for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; }
        for (var start = 0; start < list.length; start += size) {
          var name;
          do { seq++; name = 'กลุ่ม ' + seq; } while (names.indexOf(name) >= 0);
          names.push(name);
          var wg = tx.insert('work_groups', { offering_id: auth.offering.id, name: name, status: 'active', active_count: 0 });
          WorkGroups._hist(tx, ctx, wg.id, '', 'create', 'สุ่มจัดกลุ่ม');
          list.slice(start, start + size).forEach(function (s) { WorkGroups._place(tx, ctx, auth.offering.id, wg, s.id, 'add'); });
          created.push(wg.id);
        }
      });
      if (created.length) WorkGroups.syncOffering(tx, auth.offering.id, created, ctx);
      tx.afterCommit(function () { Audit.log(ctx, 'wg.auto', 'course_offerings', auth.offering.id, { groups: created.length, size: size }, '', auth.offering.id); });
      return { created: created.length, students: pool.length };
    }, { actorId: ctx.user.id });
  },

  // ---------------------------------------------------------------- นักเรียน
  _studentCtx: function (tx, ctx, offeringId, forWrite) {
    var e = Authz.requireEnrollment(ctx, offeringId, forWrite);
    var o = tx.get('course_offerings', offeringId);
    if (forWrite && o.groups_locked) Errors.raise('GROUPS_LOCKED');
    var mem = tx.find('work_group_members', { offering_id: offeringId, student_id: ctx.student.id, status: 'active' })[0] || null;
    var wg = mem ? tx.get('work_groups', mem.work_group_id) : null;
    return { offering: o, enrollment: e.enrollment, membership: mem, group: wg };
  },

  mine: function (ctx, offeringId) {
    var rc = WorkGroups._studentCtx(Db, ctx, offeringId, false);
    var o = rc.offering;
    var mems = Db.find('work_group_members', { offering_id: o.id });
    var grouped = {};
    mems.forEach(function (m) { if (m.status === 'active') grouped[m.student_id] = true; });
    var enrolled = WorkGroups._activeEnrolled(Db, o.id);
    var brief = function (sid, leader) { var b = WorkGroups._studentBrief(sid, leader); return b ? { studentId: b.studentId, name: b.name, roomLabel: b.roomLabel, isLeader: b.isLeader } : null; };
    var my = null;
    if (rc.group) {
      var g = rc.group;
      my = {
        id: g.id, name: g.name, isLeader: g.leader_student_id === ctx.student.id,
        members: mems.filter(function (m) { return m.work_group_id === g.id && m.status === 'active'; }).map(function (m) { return brief(m.student_id, g.leader_student_id); }).filter(Boolean),
        invited: mems.filter(function (m) { return m.work_group_id === g.id && m.status === 'invited'; }).map(function (m) { return brief(m.student_id, ''); }).filter(Boolean)
      };
    }
    var sets = Util.indexBy(Db.find('assignment_group_sets', { offering_id: o.id }), 'assessment_id');
    return {
      settings: { maxSize: Number(o.group_max_size || 0), leaderDirectAdd: !!o.leader_direct_add, locked: !!o.groups_locked },
      myGroup: my,
      invitations: mems.filter(function (m) { return m.student_id === ctx.student.id && m.status === 'invited'; }).map(function (m) {
        var w = Db.get('work_groups', m.work_group_id);
        if (!w || w.status !== 'active') return null;
        return {
          memberId: m.id, groupName: w.name,
          members: mems.filter(function (x) { return x.work_group_id === w.id && x.status === 'active'; }).map(function (x) { var b = brief(x.student_id, w.leader_student_id); return b ? b.name + (b.isLeader ? ' (หัวหน้า)' : '') : ''; })
        };
      }).filter(Boolean),
      classmates: Object.keys(enrolled).filter(function (sid) { return !grouped[sid] && sid !== ctx.student.id; })
        .map(function (sid) { return Db.get('students', sid); }).filter(Boolean).sort(Registry.compareStudents)
        .map(function (s) { return brief(s.id, ''); }),
      otherGroups: Db.find('work_groups', { offering_id: o.id }).filter(function (w) { return w.status === 'active' && (!rc.group || w.id !== rc.group.id); })
        .map(function (w) { return { name: w.name, count: Number(w.active_count || 0) }; }),
      groupAssessments: Db.find('assessments', { offering_id: o.id, status: 'published' }).filter(function (a) {
        return a.kind === 'group' && sets[a.id] && sets[a.id].source === 'work_groups';
      }).map(function (a) { return { id: a.id, code: a.code, title: a.title }; })
    };
  },

  create: function (ctx, req) {
    var name = Util.requireStr(req.name, 'ชื่อกลุ่ม', 100);
    return Db.tx('wg.studentCreate', function (tx) {
      var rc = WorkGroups._studentCtx(tx, ctx, req.offeringId, true);
      if (rc.group) Errors.raise('GROUP_ALREADY_MEMBER', 'คุณมีกลุ่มในรายวิชานี้แล้ว (หนึ่งคนอยู่ได้หนึ่งกลุ่มต่อรายวิชา)');
      if (tx.find('work_groups', { offering_id: req.offeringId }).some(function (w) { return w.status === 'active' && w.name === name; })) Errors.raise('DUPLICATE', 'มีกลุ่มชื่อนี้แล้ว');
      var wg = tx.insert('work_groups', { offering_id: req.offeringId, name: name, leader_student_id: ctx.student.id, status: 'active', active_count: 0 });
      WorkGroups._hist(tx, ctx, wg.id, ctx.student.id, 'create', '');
      WorkGroups._place(tx, ctx, req.offeringId, wg, ctx.student.id, 'accept');
      WorkGroups.syncOffering(tx, req.offeringId, [wg.id], ctx);
      return { id: wg.id };
    }, { actorId: ctx.user.id });
  },

  /** หัวหน้ากลุ่มเลือกสมาชิก: ส่งคำเชิญ (ค่าเริ่มต้น) หรือเพิ่มทันทีเมื่อครูอนุญาต */
  invite: function (ctx, req) {
    var ids = (req.studentIds || []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!ids.length) Errors.raise('VALIDATION', 'กรุณาเลือกเพื่อนอย่างน้อยหนึ่งคน');
    var notify = [];
    var out = Db.tx('wg.invite', function (tx) {
      var rc = WorkGroups._studentCtx(tx, ctx, req.offeringId, true);
      if (!rc.group) Errors.raise('GROUP_REQUIRED', 'กรุณาสร้างกลุ่มก่อน');
      if (rc.group.leader_student_id !== ctx.student.id) Errors.raise('FORBIDDEN', 'เฉพาะหัวหน้ากลุ่มเลือกสมาชิกได้');
      var enrolled = WorkGroups._activeEnrolled(tx, req.offeringId);
      var max = Number(rc.offering.group_max_size || 0);
      var direct = !!rc.offering.leader_direct_add;
      var count = tx.find('work_group_members', { work_group_id: rc.group.id, status: 'active' }).length;
      var touched = [];
      ids.forEach(function (sid) {
        var s = tx.get('students', sid);
        if (!s || !enrolled[sid] || sid === ctx.student.id) Errors.raise('VALIDATION', 'เลือกได้เฉพาะเพื่อนที่ลงทะเบียนในรายวิชานี้');
        if (tx.find('work_group_members', { offering_id: req.offeringId, student_id: sid, status: 'active' }).length) {
          Errors.raise('VALIDATION', Registry.personName(s) + ' อยู่ในกลุ่มอื่นแล้ว');
        }
        if (direct) {
          if (max && count + 1 > max) Errors.raise('GROUP_FULL', 'กลุ่มมีสมาชิกครบ ' + max + ' คนแล้ว');
          touched = touched.concat(WorkGroups._place(tx, ctx, req.offeringId, rc.group, sid, 'add'));
          count++;
        } else {
          var pending = tx.find('work_group_members', { work_group_id: rc.group.id, student_id: sid }).filter(function (m) { return m.status === 'invited'; });
          if (pending.length) return;
          tx.insert('work_group_members', { work_group_id: rc.group.id, offering_id: req.offeringId, student_id: sid, status: 'invited', added_by_user_id: ctx.user.id });
          WorkGroups._hist(tx, ctx, rc.group.id, sid, 'invite', '');
        }
        if (s.user_id) notify.push(s.user_id);
      });
      if (touched.length) WorkGroups.syncOffering(tx, req.offeringId, touched, ctx);
      return { mode: direct ? 'added' : 'invited', count: ids.length, groupName: rc.group.name };
    }, { actorId: ctx.user.id });
    Notify.sendMany(notify, 'group_invite', out.mode === 'added' ? 'คุณถูกเพิ่มเข้ากลุ่ม "' + out.groupName + '"' : 'ได้รับคำเชิญเข้ากลุ่ม "' + out.groupName + '"', 'เปิดรายวิชาเพื่อดูรายละเอียดกลุ่ม', 'offering:' + req.offeringId);
    return out;
  },

  respond: function (ctx, req) {
    return Db.tx('wg.respond', function (tx) {
      var m = tx.get('work_group_members', req.memberId);
      if (!m || !ctx.student || m.student_id !== ctx.student.id || m.status !== 'invited') Errors.raise('NOT_FOUND');
      var rc = WorkGroups._studentCtx(tx, ctx, m.offering_id, true);
      var wg = tx.get('work_groups', m.work_group_id);
      if (!req.accept) {
        tx.update('work_group_members', m.id, { status: 'declined', responded_at: tx.now });
        WorkGroups._hist(tx, ctx, wg.id, m.student_id, 'decline', '');
        return { ok: true };
      }
      if (wg.status !== 'active') Errors.raise('NOT_FOUND', 'กลุ่มนี้ถูกยุบแล้ว');
      if (rc.group) Errors.raise('GROUP_ALREADY_MEMBER', 'คุณมีกลุ่มในรายวิชานี้แล้ว ต้องออกจากกลุ่มเดิมก่อน');
      var max = Number(rc.offering.group_max_size || 0);
      if (max && tx.find('work_group_members', { work_group_id: wg.id, status: 'active' }).length >= max) Errors.raise('GROUP_FULL');
      tx.update('work_group_members', m.id, { status: 'active', responded_at: tx.now });
      WorkGroups._recount(tx, wg.id);
      WorkGroups._cancelInvites(tx, m.offering_id, m.student_id);
      WorkGroups._hist(tx, ctx, wg.id, m.student_id, 'accept', '');
      WorkGroups.syncOffering(tx, m.offering_id, [wg.id], ctx);
      return { ok: true, groupId: wg.id };
    }, { actorId: ctx.user.id });
  },

  leave: function (ctx, req) {
    return Db.tx('wg.leave', function (tx) {
      var rc = WorkGroups._studentCtx(tx, ctx, req.offeringId, true);
      if (!rc.group) Errors.raise('GROUP_REQUIRED');
      tx.update('work_group_members', rc.membership.id, { status: 'left', responded_at: tx.now });
      WorkGroups._hist(tx, ctx, rc.group.id, ctx.student.id, 'leave', '');
      WorkGroups._afterLeave(tx, ctx, rc.group, ctx.student.id);
      WorkGroups.syncOffering(tx, req.offeringId, [rc.group.id], ctx);
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  /** หัวหน้ากลุ่มนำสมาชิกออก หรือยกเลิกคำเชิญ */
  leaderRemove: function (ctx, req) {
    return Db.tx('wg.leaderRemove', function (tx) {
      var rc = WorkGroups._studentCtx(tx, ctx, req.offeringId, true);
      if (!rc.group || rc.group.leader_student_id !== ctx.student.id) Errors.raise('FORBIDDEN', 'เฉพาะหัวหน้ากลุ่ม');
      if (req.studentId === ctx.student.id) Errors.raise('VALIDATION', 'ใช้ "ออกจากกลุ่ม" แทน');
      var m = tx.find('work_group_members', { work_group_id: rc.group.id, student_id: req.studentId }).filter(function (x) { return x.status === 'active' || x.status === 'invited'; })[0];
      if (!m) Errors.raise('NOT_FOUND');
      tx.update('work_group_members', m.id, { status: m.status === 'invited' ? 'cancelled' : 'removed', responded_at: tx.now });
      if (m.status === 'active') {
        WorkGroups._hist(tx, ctx, rc.group.id, req.studentId, 'remove', 'หัวหน้ากลุ่มนำออก');
        WorkGroups._afterLeave(tx, ctx, rc.group, req.studentId);
        WorkGroups.syncOffering(tx, req.offeringId, [rc.group.id], ctx);
      }
      return { ok: true };
    }, { actorId: ctx.user.id });
  }
};
