/**
 * บันทึกตรวจสอบ (AuditLog) และแจ้งเตือนในระบบ
 * เขียนด้วย appendRow (ไม่รอล็อก) และเรียกหลังธุรกรรมสำเร็จเท่านั้น (tx.afterCommit)
 */
var Audit = {
  SENSITIVE: /pass|token|secret|pepper|ticket|resumable|url|hash/i,

  sanitize: function (detail) {
    if (detail === null || detail === undefined) return null;
    var seen = 0;
    function clean(v, depth) {
      if (++seen > 500 || depth > 5) return '[truncated]';
      if (Array.isArray(v)) return v.slice(0, 100).map(function (x) { return clean(x, depth + 1); });
      if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).forEach(function (k) {
          o[k] = Audit.SENSITIVE.test(k) ? '[redacted]' : clean(v[k], depth + 1);
        });
        return o;
      }
      if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
      return v;
    }
    var out = clean(detail, 0);
    var s = JSON.stringify(out);
    if (s.length > 8000) return { truncated: true, preview: s.slice(0, 7900) };
    return out;
  },

  log: function (ctx, action, entity, entityId, detail, reason, offeringId) {
    try {
      Db.append('audit_log', {
        actor_role: ctx && ctx.primaryRole || '',
        action: action,
        entity: entity || '',
        entity_id: entityId || '',
        offering_id: offeringId || '',
        detail_json: Audit.sanitize(detail),
        reason: reason || '',
        request_id: ctx && ctx.requestId || ''
      }, ctx && ctx.user && ctx.user.id);
    } catch (e) {
      console.error('audit failed: ' + e);
    }
  },

  system: function (action, entity, entityId, detail) {
    Audit.log({ primaryRole: 'system' }, action, entity, entityId, detail);
  }
};

var Notify = {
  /** ข้อความแจ้งเตือนต้องไม่มีคะแนนส่วนตัว */
  send: function (userIds, type, title, body, link) {
    (userIds || []).filter(Boolean).forEach(function (uid) {
      try {
        Db.tx('notify', function (tx) {
          tx.insert('notifications', { user_id: uid, type: type, title: title, body: body || '', link: link || '' });
        });
      } catch (e) {
        console.error('notify failed: ' + e);
      }
    });
  },

  sendMany: function (userIds, type, title, body, link) {
    var ids = (userIds || []).filter(Boolean);
    if (!ids.length) return;
    try {
      Db.tx('notify', function (tx) {
        ids.forEach(function (uid) {
          tx.insert('notifications', { user_id: uid, type: type, title: title, body: body || '', link: link || '' });
        });
      });
    } catch (e) {
      console.error('notify failed: ' + e);
    }
  },

  listMine: function (ctx) {
    return Db.find('notifications', { user_id: ctx.user.id })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
      .slice(0, 50)
      .map(function (n) {
        return { id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: !!n.read_at, version: n.version };
      });
  },

  markRead: function (ctx, ids) {
    return Db.tx('notify.read', function (tx) {
      (ids || []).slice(0, 100).forEach(function (id) {
        var n = tx.get('notifications', id);
        if (n && n.user_id === ctx.user.id && !n.read_at) tx.update('notifications', id, { read_at: tx.now });
      });
      return true;
    }, { actorId: ctx.user.id });
  }
};
