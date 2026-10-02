/**
 * การจัดกลุ่มด้วยตนเองและ snapshot สมาชิก
 *
 * - กลุ่มแยกตามงาน (assignment_group_sets 1:1 กับ assessment)
 * - นักเรียนสร้างกลุ่ม เชิญ ขอเข้าร่วม ตอบรับ/ปฏิเสธ ออกจากกลุ่มได้ สมาชิกต้องยืนยันเอง
 * - หนึ่งคน active ได้หนึ่งกลุ่มต่องาน และต้องลงทะเบียนในรายวิชานั้น
 * - จำนวนสมาชิกตรวจภายใต้ script lock (Db.tx) นับจากแถวจริงทุกครั้ง ป้องกันสองคนเข้าที่ว่างสุดท้ายพร้อมกัน
 * - ตรึงรายชื่อ (snapshot) เมื่อส่งงานครั้งแรกหรือถึงวันปิดจัดกลุ่ม แล้วแต่อย่างใดเกิดก่อน
 * - หลังตรึง ครูเท่านั้นที่ย้ายสมาชิกได้ ต้องดูผลกระทบและยืนยันพร้อมเหตุผล ระบบสร้าง snapshot รุ่นใหม่
 *   รุ่นการส่งเดิมยังชี้ snapshot เดิม คะแนนเดิมไม่ถูกย้ายอัตโนมัติ
 */
var Groups = {
  STATUS_LABELS: {
    forming: 'กำลังจัดกลุ่ม', pending_approval: 'รอครูอนุมัติ', approved: 'ครูอนุมัติแล้ว',
    frozen: 'ตรึงรายชื่อแล้ว', disbanded: 'ยุบกลุ่มแล้ว'
  },

  studentName: function (s) {
    return s ? [s.prefix, s.first_name, s.last_name].join(' ').trim() : '';
  },

  activeMemberships: function (groupId) {
    return Db.find('group_memberships', { group_id: groupId, status: 'active' });
  },

  currentSnapshot: function (group) {
    if (!group.snapshot_no) return [];
    return Db.find('assignment_member_snapshots', { group_id: group.id, snapshot_no: group.snapshot_no });
  },

  inCurrentSnapshot: function (group, studentId) {
    return Groups.currentSnapshot(group).some(function (m) { return m.student_id === studentId; });
  },

  memberStudentIds: function (group) {
    var rows = group.frozen_at ? Groups.currentSnapshot(group) : Groups.activeMemberships(group.id);
    return rows.map(function (r) { return r.student_id; });
  },

  memberNames: function (group) {
    return Groups.memberStudentIds(group).map(function (sid) {
      var s = Db.get('students', sid);
      return s ? { studentId: s.id, studentCode: s.student_code, name: Groups.studentName(s), room: s.room, isLeader: group.leader_student_id === s.id } : null;
    }).filter(Boolean);
  },

  snapshotUserIds: function (group) {
    return Groups.memberStudentIds(group).map(function (sid) { var s = Db.get('students', sid); return s && s.user_id; }).filter(Boolean);
  },

  /** ข้อมูลกลุ่มสำหรับนักเรียน: เฉพาะชื่อและห้องของเพื่อน */
  groupDtoForStudent: function (group) {
    var gs = Db.get('assignment_group_sets', group.group_set_id);
    return {
      id: group.id, name: group.name, status: group.status, statusLabel: Groups.STATUS_LABELS[group.status],
      frozen: !!group.frozen_at, leaderStudentId: group.leader_student_id,
      members: Groups.memberNames(group).map(function (m) { return { studentId: m.studentId, name: m.name, room: m.room, isLeader: m.isLeader }; }),
      pending: Db.find('group_memberships', { group_id: group.id }).filter(function (m) { return m.status === 'invited' || m.status === 'requested'; })
        .map(function (m) { var s = Db.get('students', m.student_id); return { membershipId: m.id, status: m.status, name: Groups.studentName(s), room: s && s.room }; }),
      minSize: gs ? gs.min_size : null, maxSize: gs ? gs.max_size : null,
      formationCloseAt: gs ? gs.formation_close_at : '', requireApproval: gs ? gs.require_approval : false,
      version: group.version
    };
  },

  history: function (tx, ctx, group, studentId, action, reason, detail) {
    var row = { group_set_id: group.group_set_id, group_id: group.id, student_id: studentId || '', action: action, reason: reason || '', detail_json: detail || null };
    tx.afterCommit(function () {
      try { Db.append('group_membership_history', row, ctx && ctx.user ? ctx.user.id : ''); } catch (e) { console.error(e); }
    });
  },

  recount: function (tx, groupId) {
    var n = tx.find('group_memberships', { group_id: groupId, status: 'active' }).length;
    tx.update('groups', groupId, { active_count: n });
    return n;
  },

  /** ตรึงรายชื่อสมาชิกปัจจุบันเป็น snapshot รุ่นใหม่ */
  freeze: function (tx, group, trigger, reason, ctx) {
    var g = tx.get('groups', group.id);
    var members = tx.find('group_memberships', { group_id: g.id, status: 'active' });
    var no = Number(g.snapshot_no || 0) + 1;
    tx.find('assignment_member_snapshots', { group_id: g.id }).forEach(function (r) {
      if (r.is_current) tx.update('assignment_member_snapshots', r.id, { is_current: false });
    });
    var off = tx.get('course_offerings', g.offering_id);
    members.forEach(function (m) {
      var enr = tx.one('enrollments', { offering_id: off.id, student_id: m.student_id });
      tx.insert('assignment_member_snapshots', {
        assessment_id: g.assessment_id, group_id: g.id, snapshot_no: no, student_id: m.student_id,
        enrollment_id: enr ? enr.id : '', trigger: trigger, is_current: true, reason: reason || ''
      });
    });
    tx.find('group_memberships', { group_id: g.id }).forEach(function (m) {
      if (m.status === 'invited' || m.status === 'requested') tx.update('group_memberships', m.id, { status: 'cancelled', responded_at: tx.now });
    });
    tx.update('groups', g.id, {
      frozen_at: g.frozen_at || tx.now, frozen_reason: g.frozen_reason || trigger, status: 'frozen', snapshot_no: no
    });
    Groups.history(tx, ctx, g, '', 'freeze', reason, { trigger: trigger, snapshotNo: no, members: members.map(function (m) { return m.student_id; }) });
    return no;
  },

  /** ถึงวันปิดจัดกลุ่มแล้ว: ตรึงทุกกลุ่มที่ยังไม่ตรึง */
  freezeSetIfClosed: function (tx, gs) {
    var set = tx.get('assignment_group_sets', gs.id);
    if (!set.formation_close_at || tx.now <= set.formation_close_at || set.all_frozen_at) return false;
    tx.find('groups', { group_set_id: set.id }).forEach(function (g) {
      if (g.status === 'disbanded' || g.frozen_at) return;
      if (tx.find('group_memberships', { group_id: g.id, status: 'active' }).length === 0) return;
      Groups.freeze(tx, g, 'formation_closed', '');
    });
    tx.update('assignment_group_sets', set.id, { all_frozen_at: tx.now });
    return true;
  },

  /**
   * ตรึงกลุ่มที่ถึงวันปิดจัดกลุ่มในธุรกรรมของตัวเองก่อนทำรายการ
   * (หากตรึงในธุรกรรมเดียวกับรายการที่ถูกปฏิเสธ การตรึงจะถูกย้อนกลับไปด้วย)
   */
  preFreeze: function (assessmentId) {
    var gs = Db.one('assignment_group_sets', { assessment_id: assessmentId });
    if (gs && gs.formation_close_at && Util.nowIso() > gs.formation_close_at && !gs.all_frozen_at) {
      Db.tx('group.autoFreeze', function (tx) { Groups.freezeSetIfClosed(tx, gs); });
    }
  },

  _assessmentOfMembership: function (membershipId) {
    var m = Db.get('group_memberships', membershipId);
    var g = m ? Db.get('groups', m.group_id) : null;
    return g ? g.assessment_id : '';
  },

  _studentRc: function (tx, ctx, assessmentId) {
    var rc = Submission.resolve(ctx, assessmentId, true);
    if (rc.assessment.kind !== 'group' || !rc.groupSet) Errors.raise('VALIDATION', 'งานนี้ไม่ใช่งานกลุ่ม');
    if (rc.groupSet.source === 'work_groups') Errors.raise('VALIDATION', 'งานนี้ใช้กลุ่มประจำรายวิชา จัดการกลุ่มได้ที่หน้า "กลุ่มของฉัน" ของรายวิชา');
    Groups.freezeSetIfClosed(tx, rc.groupSet);
    var gs = tx.get('assignment_group_sets', rc.groupSet.id);
    if (gs.formation_close_at && tx.now > gs.formation_close_at) Errors.raise('GROUP_FORMATION_CLOSED');
    rc.groupSet = gs;
    rc.membership = tx.find('group_memberships', { group_set_id: gs.id, student_id: ctx.student.id, status: 'active' })[0] || null;
    rc.group = rc.membership ? tx.get('groups', rc.membership.group_id) : null;
    return rc;
  },

  _cancelOtherPending: function (tx, gsId, studentId, exceptId) {
    tx.find('group_memberships', { group_set_id: gsId, student_id: studentId }).forEach(function (m) {
      if (m.id !== exceptId && (m.status === 'invited' || m.status === 'requested')) tx.update('group_memberships', m.id, { status: 'cancelled', responded_at: tx.now });
    });
  },

  _activate: function (tx, ctx, membership, group, gs) {
    if (group.frozen_at || group.status === 'frozen') Errors.raise('GROUP_FROZEN');
    if (group.status === 'disbanded') Errors.raise('NOT_FOUND', 'กลุ่มนี้ถูกยุบแล้ว');
    var already = tx.find('group_memberships', { group_set_id: gs.id, student_id: membership.student_id, status: 'active' });
    if (already.length) Errors.raise('GROUP_ALREADY_MEMBER');
    var count = tx.find('group_memberships', { group_id: group.id, status: 'active' }).length;
    if (count >= gs.max_size) Errors.raise('GROUP_FULL');
    var action = membership.status === 'requested' ? 'approve' : 'accept';
    tx.update('group_memberships', membership.id, { status: 'active', responded_at: tx.now });
    Groups.recount(tx, group.id);
    Groups._cancelOtherPending(tx, gs.id, membership.student_id, membership.id);
    Groups.history(tx, ctx, group, membership.student_id, action, '');
  },

  // ---------------- นักเรียน ----------------
  create: function (ctx, req) {
    var name = Util.requireStr(req.name, 'ชื่อกลุ่ม', 100);
    Groups.preFreeze(req.assessmentId);
    return Db.tx('group.create', function (tx) {
      var rc = Groups._studentRc(tx, ctx, req.assessmentId);
      if (rc.membership) Errors.raise('GROUP_ALREADY_MEMBER');
      var gs = rc.groupSet;
      var g = tx.insert('groups', {
        group_set_id: gs.id, assessment_id: gs.assessment_id, offering_id: gs.offering_id, name: name,
        leader_student_id: ctx.student.id, status: gs.require_approval ? 'pending_approval' : 'forming', active_count: 1
      });
      tx.insert('group_memberships', { group_set_id: gs.id, group_id: g.id, student_id: ctx.student.id, status: 'active', invited_by_user_id: ctx.user.id, responded_at: tx.now });
      Groups._cancelOtherPending(tx, gs.id, ctx.student.id, '');
      Groups.history(tx, ctx, g, ctx.student.id, 'create', '');
      return { groupId: g.id };
    }, { actorId: ctx.user.id });
  },

  invite: function (ctx, req) {
    Groups.preFreeze(req.assessmentId);
    return Db.tx('group.invite', function (tx) {
      var rc = Groups._studentRc(tx, ctx, req.assessmentId);
      if (!rc.group) Errors.raise('GROUP_REQUIRED');
      if (rc.group.frozen_at) Errors.raise('GROUP_FROZEN');
      var target = tx.get('students', req.studentId);
      if (!target || target.school_id !== ctx.schoolId || target.id === ctx.student.id) Errors.raise('NOT_FOUND');
      var enr = tx.one('enrollments', { offering_id: rc.offering.id, student_id: target.id });
      if (!enr || enr.status !== 'active') Errors.raise('VALIDATION', 'เพื่อนคนนี้ไม่ได้ลงทะเบียนในรายวิชานี้');
      if (tx.find('group_memberships', { group_set_id: rc.groupSet.id, student_id: target.id, status: 'active' }).length) {
        Errors.raise('VALIDATION', 'เพื่อนคนนี้อยู่ในกลุ่มอื่นของงานนี้แล้ว');
      }
      var pending = tx.find('group_memberships', { group_id: rc.group.id, student_id: target.id }).filter(function (m) { return m.status === 'invited' || m.status === 'requested'; });
      if (pending.length) Errors.raise('DUPLICATE', 'มีคำเชิญ/คำขอค้างอยู่แล้ว');
      var m = tx.insert('group_memberships', { group_set_id: rc.groupSet.id, group_id: rc.group.id, student_id: target.id, status: 'invited', invited_by_user_id: ctx.user.id });
      Groups.history(tx, ctx, rc.group, target.id, 'invite', '');
      var groupName = rc.group.name, title = rc.assessment.title, aid = rc.assessment.id;
      tx.afterCommit(function () {
        if (target.user_id) Notify.sendMany([target.user_id], 'group_invite', 'ได้รับคำเชิญเข้ากลุ่ม "' + groupName + '"', 'งาน: ' + title, 'assessment:' + aid);
      });
      return { membershipId: m.id };
    }, { actorId: ctx.user.id });
  },

  respond: function (ctx, req) {
    Groups.preFreeze(Groups._assessmentOfMembership(req.membershipId));
    return Db.tx('group.respond', function (tx) {
      var m = tx.get('group_memberships', req.membershipId);
      if (!m || !ctx.student || m.student_id !== ctx.student.id || m.status !== 'invited') Errors.raise('NOT_FOUND');
      var g = tx.get('groups', m.group_id);
      var rc = Groups._studentRc(tx, ctx, g.assessment_id);
      if (req.accept) {
        Groups._activate(tx, ctx, m, g, rc.groupSet);
      } else {
        tx.update('group_memberships', m.id, { status: 'declined', responded_at: tx.now });
        Groups.history(tx, ctx, g, m.student_id, 'decline', '');
      }
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  requestJoin: function (ctx, req) {
    Groups.preFreeze(req.assessmentId);
    return Db.tx('group.request', function (tx) {
      var rc = Groups._studentRc(tx, ctx, req.assessmentId);
      if (rc.membership) Errors.raise('GROUP_ALREADY_MEMBER');
      var g = tx.get('groups', req.groupId);
      if (!g || g.group_set_id !== rc.groupSet.id || g.status === 'disbanded') Errors.raise('NOT_FOUND');
      if (g.frozen_at) Errors.raise('GROUP_FROZEN');
      if (tx.find('group_memberships', { group_id: g.id, status: 'active' }).length >= rc.groupSet.max_size) Errors.raise('GROUP_FULL');
      var dup = tx.find('group_memberships', { group_id: g.id, student_id: ctx.student.id }).filter(function (m) { return m.status === 'invited' || m.status === 'requested'; });
      if (dup.length) Errors.raise('DUPLICATE', 'มีคำขอ/คำเชิญค้างอยู่แล้ว');
      var m = tx.insert('group_memberships', { group_set_id: rc.groupSet.id, group_id: g.id, student_id: ctx.student.id, status: 'requested', invited_by_user_id: ctx.user.id });
      Groups.history(tx, ctx, g, ctx.student.id, 'request', '');
      return { membershipId: m.id };
    }, { actorId: ctx.user.id });
  },

  decideRequest: function (ctx, req) {
    Groups.preFreeze(Groups._assessmentOfMembership(req.membershipId));
    return Db.tx('group.decide', function (tx) {
      var m = tx.get('group_memberships', req.membershipId);
      if (!m || m.status !== 'requested') Errors.raise('NOT_FOUND');
      var g = tx.get('groups', m.group_id);
      var rc = Groups._studentRc(tx, ctx, g.assessment_id);
      if (!rc.group || rc.group.id !== g.id) Errors.raise('FORBIDDEN');
      if (req.approve) Groups._activate(tx, ctx, m, g, rc.groupSet);
      else {
        tx.update('group_memberships', m.id, { status: 'declined', responded_at: tx.now });
        Groups.history(tx, ctx, g, m.student_id, 'decline', '');
      }
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  leave: function (ctx, req) {
    Groups.preFreeze(req.assessmentId);
    return Db.tx('group.leave', function (tx) {
      var rc = Groups._studentRc(tx, ctx, req.assessmentId);
      if (!rc.group) Errors.raise('GROUP_REQUIRED');
      if (rc.group.frozen_at) Errors.raise('GROUP_FROZEN');
      tx.update('group_memberships', rc.membership.id, { status: 'left', responded_at: tx.now });
      var n = Groups.recount(tx, rc.group.id);
      var patch = {};
      if (n === 0) {
        patch.status = 'disbanded';
        tx.find('group_memberships', { group_id: rc.group.id }).forEach(function (m) {
          if (m.status === 'invited' || m.status === 'requested') tx.update('group_memberships', m.id, { status: 'cancelled', responded_at: tx.now });
        });
      } else if (rc.group.leader_student_id === ctx.student.id) {
        patch.leader_student_id = tx.find('group_memberships', { group_id: rc.group.id, status: 'active' })[0].student_id;
      }
      if (Object.keys(patch).length) tx.update('groups', rc.group.id, patch);
      Groups.history(tx, ctx, rc.group, ctx.student.id, 'leave', '');
      return { ok: true, disbanded: n === 0 };
    }, { actorId: ctx.user.id });
  },

  /** หน้าจัดกลุ่มของนักเรียน: กลุ่มของฉัน คำเชิญ กลุ่มที่ขอเข้าได้ และเพื่อนที่ยังไม่มีกลุ่ม (เฉพาะชื่อและห้อง) */
  forStudent: function (ctx, assessmentId) {
    var rc = Submission.resolve(ctx, assessmentId, false);
    if (rc.assessment.kind !== 'group' || !rc.groupSet) Errors.raise('VALIDATION', 'งานนี้ไม่ใช่งานกลุ่ม');
    var gs = rc.groupSet;
    var memberships = Db.find('group_memberships', { group_set_id: gs.id });
    var activeIds = memberships.filter(function (m) { return m.status === 'active'; }).map(function (m) { return m.student_id; });
    var groups = Db.find('groups', { group_set_id: gs.id }).filter(function (g) { return g.status !== 'disbanded'; });
    var invites = memberships.filter(function (m) { return m.student_id === ctx.student.id && m.status === 'invited'; }).map(function (m) {
      var g = Db.get('groups', m.group_id);
      return { membershipId: m.id, groupId: g.id, groupName: g.name, members: Groups.memberNames(g).map(function (x) { return x.name; }) };
    });
    var closed = !!(gs.formation_close_at && Util.nowIso() > gs.formation_close_at);
    return {
      settings: { minSize: gs.min_size, maxSize: gs.max_size, formationCloseAt: gs.formation_close_at, requireApproval: gs.require_approval, closed: closed, source: gs.source || 'self' },
      myGroup: rc.group ? Groups.groupDtoForStudent(rc.group) : null,
      invitations: invites,
      openGroups: rc.group ? [] : groups.filter(function (g) { return !g.frozen_at && g.active_count < gs.max_size; })
        .map(function (g) { return { id: g.id, name: g.name, count: g.active_count, maxSize: gs.max_size }; }),
      classmatesWithoutGroup: Db.find('enrollments', { offering_id: rc.offering.id }).filter(function (e) {
        return e.status === 'active' && activeIds.indexOf(e.student_id) < 0 && e.student_id !== ctx.student.id;
      }).map(function (e) { var s = Db.get('students', e.student_id); return { studentId: s.id, name: Groups.studentName(s), room: s.room }; })
    };
  },

  // ---------------- ครู ----------------
  teacherOverview: function (ctx, assessmentId) {
    var a = Db.get('assessments', assessmentId);
    if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
    Authz.requireOffering(ctx, a.offering_id, 'can_view');
    var gs = Db.one('assignment_group_sets', { assessment_id: a.id });
    if (!gs) Errors.raise('NOT_FOUND');
    var groups = Db.find('groups', { group_set_id: gs.id }).filter(function (g) { return g.status !== 'disbanded'; });
    var grouped = {};
    var rows = groups.map(function (g) {
      var members = Groups.memberNames(g);
      members.forEach(function (m) { grouped[m.studentId] = true; });
      var n = members.length;
      return {
        id: g.id, name: g.name, status: g.status, statusLabel: Groups.STATUS_LABELS[g.status], frozen: !!g.frozen_at,
        frozenReason: g.frozen_reason, snapshotNo: g.snapshot_no, members: members, count: n,
        sizeOk: g.size_exception || (n >= gs.min_size && n <= gs.max_size), sizeException: g.size_exception,
        sizeExceptionReason: g.size_exception_reason, version: g.version
      };
    });
    Db.find('group_memberships', { group_set_id: gs.id, status: 'active' }).forEach(function (m) { grouped[m.student_id] = true; });
    var ungrouped = Db.find('enrollments', { offering_id: a.offering_id }).filter(function (e) {
      return e.status === 'active' && !grouped[e.student_id];
    }).map(function (e) { var s = Db.get('students', e.student_id); return { studentId: s.id, studentCode: s.student_code, name: Groups.studentName(s), room: s.room }; });
    return {
      settings: { id: gs.id, minSize: gs.min_size, maxSize: gs.max_size, formationCloseAt: gs.formation_close_at, requireApproval: gs.require_approval, source: gs.source || 'self' },
      groups: rows,
      incomplete: rows.filter(function (r) { return !r.sizeOk; }).map(function (r) { return { id: r.id, name: r.name, count: r.count }; }),
      ungrouped: ungrouped,
      pendingApproval: rows.filter(function (r) { return r.status === 'pending_approval'; }).length
    };
  },

  teacherApprove: function (ctx, req) {
    return Db.tx('group.teacherApprove', function (tx) {
      var g = tx.get('groups', req.groupId);
      if (!g) Errors.raise('NOT_FOUND');
      Authz.requireOffering(ctx, g.offering_id, 'can_manage');
      var patch = {};
      if (g.status === 'pending_approval' || g.status === 'forming') patch.status = 'approved';
      if (req.sizeException !== undefined) {
        var reason = Util.str(req.reason, 500);
        if (req.sizeException && !reason) Errors.raise('VALIDATION', 'กรุณาระบุเหตุผลของข้อยกเว้นจำนวนสมาชิก');
        patch.size_exception = !!req.sizeException;
        patch.size_exception_reason = reason;
      }
      tx.update('groups', g.id, patch, { expectedVersion: req.expectedVersion });
      Groups.history(tx, ctx, g, '', 'approve_group', req.reason, patch);
      return { ok: true };
    }, { actorId: ctx.user.id });
  },

  /**
   * ครูย้าย/จัดนักเรียนเข้ากลุ่ม (ใช้ได้ทั้งก่อนและหลังตรึง)
   * หลังตรึงต้องส่ง confirm=true และเหตุผล ระบบจะคืนตัวอย่างผลกระทบก่อน
   */
  teacherAssign: function (ctx, req) {
    return Db.tx('group.teacherAssign', function (tx) {
      var a = tx.get('assessments', req.assessmentId);
      if (!a || a.kind !== 'group') Errors.raise('NOT_FOUND');
      Authz.requireOffering(ctx, a.offering_id, 'can_manage');
      var gs = tx.one('assignment_group_sets', { assessment_id: a.id });
      var student = tx.get('students', req.studentId);
      var enr = student ? tx.one('enrollments', { offering_id: a.offering_id, student_id: student.id }) : null;
      if (!enr || enr.status !== 'active') Errors.raise('VALIDATION', 'นักเรียนไม่ได้ลงทะเบียนในรายวิชานี้');
      var current = tx.find('group_memberships', { group_set_id: gs.id, student_id: student.id, status: 'active' })[0] || null;
      var from = current ? tx.get('groups', current.group_id) : null;
      var to = req.groupId ? tx.get('groups', req.groupId) : null;
      if (req.groupId && (!to || to.group_set_id !== gs.id || to.status === 'disbanded')) Errors.raise('NOT_FOUND');
      if (from && to && from.id === to.id) return { ok: true, unchanged: true };
      if (gs.source === 'work_groups' && ((from && !from.frozen_at) || !to || !to.frozen_at)) {
        Errors.raise('VALIDATION', 'งานนี้ใช้กลุ่มประจำรายวิชา ให้ย้ายสมาชิกที่หน้า "กลุ่มประจำรายวิชา" (หน้านี้ใช้ปรับเฉพาะกลุ่มที่ตรึงรายชื่อแล้ว)');
      }
      var reason = Util.str(req.reason, 500);
      var affected = [from, to].filter(function (g) { return g && g.frozen_at; });
      var toCount = to ? tx.find('group_memberships', { group_id: to.id, status: 'active' }).length : 0;
      var overMax = to && toCount + 1 > gs.max_size;
      if ((affected.length || overMax) && !req.confirm) {
        return {
          needsConfirm: true,
          impact: affected.map(function (g) {
            var sub = tx.one('submissions', { assessment_id: a.id, owner_type: 'group', owner_id: g.id });
            return {
              groupId: g.id, groupName: g.name, snapshotNo: g.snapshot_no,
              submittedVersions: sub ? sub.current_version_no : 0,
              hasGroupGrade: !!tx.one('group_grades', { assessment_id: a.id, group_id: g.id }),
              note: 'รุ่นการส่งเดิมยังผูกกับรายชื่อชุดเดิม คะแนนเดิมไม่ถูกย้ายอัตโนมัติ ระบบจะสร้างรายชื่อชุดใหม่'
            };
          }),
          overMax: overMax
        };
      }
      if ((affected.length || overMax) && !reason) Errors.raise('VALIDATION', 'กรุณาระบุเหตุผล');
      if (current) {
        tx.update('group_memberships', current.id, { status: 'removed', responded_at: tx.now });
        var left = Groups.recount(tx, from.id);
        var fpatch = {};
        if (left === 0) fpatch.status = 'disbanded';
        else if (from.leader_student_id === student.id) fpatch.leader_student_id = tx.find('group_memberships', { group_id: from.id, status: 'active' })[0].student_id;
        if (Object.keys(fpatch).length) tx.update('groups', from.id, fpatch);
        Groups.history(tx, ctx, from, student.id, 'move_out', reason);
      }
      if (!to) {
        to = tx.insert('groups', {
          group_set_id: gs.id, assessment_id: a.id, offering_id: a.offering_id,
          name: Util.requireStr(req.newGroupName, 'ชื่อกลุ่ม', 100), leader_student_id: student.id, status: 'approved', active_count: 0
        });
      }
      Groups._cancelOtherPending(tx, gs.id, student.id, '');
      tx.insert('group_memberships', { group_set_id: gs.id, group_id: to.id, student_id: student.id, status: 'active', invited_by_user_id: ctx.user.id, responded_at: tx.now });
      Groups.recount(tx, to.id);
      var tpatch = {};
      if (overMax) { tpatch.size_exception = true; tpatch.size_exception_reason = reason; }
      if (!to.leader_student_id) tpatch.leader_student_id = student.id;
      if (Object.keys(tpatch).length) tx.update('groups', to.id, tpatch);
      Groups.history(tx, ctx, to, student.id, 'move_in', reason);
      [from, to].forEach(function (g) {
        if (g && tx.get('groups', g.id).frozen_at && tx.get('groups', g.id).status !== 'disbanded') Groups.freeze(tx, g, 'teacher', reason, ctx);
      });
      tx.afterCommit(function () { Audit.log(ctx, 'group.teacherAssign', 'students', student.id, { from: from && from.id, to: to.id }, reason, a.offering_id); });
      return { ok: true, groupId: to.id };
    }, { actorId: ctx.user.id });
  },

  /** คัดลอกกลุ่มจากงานก่อน (เฉพาะนักเรียนที่ยังเรียนอยู่และยังไม่มีกลุ่มในงานใหม่) */
  teacherCopyFrom: function (ctx, req) {
    return Db.tx('group.copy', function (tx) {
      var src = tx.get('assessments', req.fromAssessmentId), dst = tx.get('assessments', req.toAssessmentId);
      if (!src || !dst || src.kind !== 'group' || dst.kind !== 'group' || src.offering_id !== dst.offering_id) Errors.raise('NOT_FOUND');
      Authz.requireOffering(ctx, dst.offering_id, 'can_manage');
      var sgs = tx.one('assignment_group_sets', { assessment_id: src.id });
      var dgs = tx.one('assignment_group_sets', { assessment_id: dst.id });
      if (dgs.source === 'work_groups') Errors.raise('VALIDATION', 'งานปลายทางใช้กลุ่มประจำรายวิชาอยู่แล้ว');
      var taken = {};
      tx.find('group_memberships', { group_set_id: dgs.id, status: 'active' }).forEach(function (m) { taken[m.student_id] = true; });
      var created = 0, skipped = [];
      tx.find('groups', { group_set_id: sgs.id }).forEach(function (g) {
        if (g.status === 'disbanded') return;
        var ids = (g.frozen_at ? tx.find('assignment_member_snapshots', { group_id: g.id, snapshot_no: g.snapshot_no })
          : tx.find('group_memberships', { group_id: g.id, status: 'active' })).map(function (m) { return m.student_id; });
        var ok = ids.filter(function (sid) {
          var e = tx.one('enrollments', { offering_id: dst.offering_id, student_id: sid });
          if (!e || e.status !== 'active' || taken[sid]) { skipped.push(sid); return false; }
          return true;
        });
        if (!ok.length) return;
        var ng = tx.insert('groups', {
          group_set_id: dgs.id, assessment_id: dst.id, offering_id: dst.offering_id, name: g.name,
          leader_student_id: ok.indexOf(g.leader_student_id) >= 0 ? g.leader_student_id : ok[0], status: 'approved', active_count: ok.length
        });
        ok.forEach(function (sid) {
          taken[sid] = true;
          tx.insert('group_memberships', { group_set_id: dgs.id, group_id: ng.id, student_id: sid, status: 'active', invited_by_user_id: ctx.user.id, responded_at: tx.now });
        });
        Groups.history(tx, ctx, ng, '', 'copy_from', '', { from: g.id });
        created++;
      });
      tx.update('assignment_group_sets', dgs.id, { copied_from_set_id: sgs.id });
      return { created: created, skippedStudentIds: skipped };
    }, { actorId: ctx.user.id });
  }
};
