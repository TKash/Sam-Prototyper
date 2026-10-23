// Phone remote: links this browser (the gallery, or a prototype being
// presented) to the phone remote page (/remote#<code>). Adapted from the
// Figma TV Remote (github.com/TKash/figma-remote-).
//
// Both sides connect to a free public MQTT relay (HiveMQ) over secure
// WebSockets, on a channel named after a random pairing code. The phone
// publishes button names to <channel>/keys; this side turns the ones in
// KEYS into key presses and publishes "on"/"off" to <channel>/tv so the
// phone can show it's linked. The code lives in this browser's
// localStorage, so every page of the tool here uses the same one.
//
// A classic script (window.ClipRemote): the offline gallery file inlines it.

(function () {
  var BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  var STORE_KEY = 'cp-remote-id';
  var ID_RE = /^[a-z0-9]{8,32}$/;

  // Remote button -> [key, code, keyCode] pressed here. Also the whitelist.
  var KEYS = {
    UP: ['ArrowUp', 'ArrowUp', 38], DOWN: ['ArrowDown', 'ArrowDown', 40],
    LEFT: ['ArrowLeft', 'ArrowLeft', 37], RIGHT: ['ArrowRight', 'ArrowRight', 39],
    OK: ['Enter', 'Enter', 13], BACK: ['Backspace', 'Backspace', 8],
    HOME: ['r', 'KeyR', 82], MENU: ['m', 'KeyM', 77], HELP: ['h', 'KeyH', 72],
    VOICE: ['v', 'KeyV', 86], NEXT: ['n', 'KeyN', 78], PREV: ['p', 'KeyP', 80],
  };

  // Minimal MQTT 3.1.1 client over WebSocket (QoS 0).
  function makeMqtt(o) {
    var enc = new TextEncoder(), dec = new TextDecoder();
    var ws = null, buf, ping, timer, retry = 0, closed = false, up = false;
    function str(s) { var b = enc.encode(s); return [b.length >> 8, b.length & 255].concat(Array.from(b)); }
    function pkt(t, body) {
      var l = [], n = body.length;
      do { var d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; l.push(d); } while (n);
      return new Uint8Array([t].concat(l, body));
    }
    function connect() {
      clearTimeout(timer);
      buf = new Uint8Array(0);
      var sock = ws = new WebSocket(o.url, 'mqtt');
      sock.binaryType = 'arraybuffer';
      sock.onopen = function () {
        var flags = 2, pay = str(o.clientId);
        if (o.will) { flags |= 4 | 32; pay = pay.concat(str(o.will.topic), str(o.will.msg)); }
        sock.send(pkt(0x10, str('MQTT').concat([4, flags, 0, 20], pay)));
      };
      sock.onmessage = function (e) {
        var a = new Uint8Array(e.data), b = new Uint8Array(buf.length + a.length);
        b.set(buf); b.set(a, buf.length); buf = b;
        for (;;) {
          var m = 1, len = 0, i = 1, d;
          do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * m; m *= 128; } while (d & 128);
          if (buf.length < i + len) return;
          var t = buf[0], p = buf.slice(i, i + len);
          buf = buf.slice(i + len);
          if (t >> 4 === 2) {
            if (p[1] !== 0) { sock.close(); return; }
            up = true; retry = 0;
            (o.subs || []).forEach(function (s, k) { sock.send(pkt(0x82, [0, k + 1].concat(str(s), [0]))); });
            clearInterval(ping);
            ping = setInterval(function () { if (sock.readyState === 1) sock.send(new Uint8Array([0xC0, 0])); }, 10000);
            if (o.onState) o.onState('up');
          } else if (t >> 4 === 3) {
            var tl = p[0] << 8 | p[1], q = (t >> 1) & 3;
            if (o.onMessage) o.onMessage(dec.decode(p.slice(2, 2 + tl)), dec.decode(p.slice(2 + tl + (q ? 2 : 0))));
          }
        }
      };
      sock.onerror = function () { try { sock.close(); } catch (e) {} };
      sock.onclose = function () {
        if (sock !== ws) return;
        up = false; clearInterval(ping);
        if (closed) return;
        if (o.onState) o.onState('down');
        timer = setTimeout(connect, Math.min(8000, 500 * Math.pow(2, retry++)));
      };
    }
    connect();
    return {
      publish: function (topic, msg, retain) {
        if (!up) return false;
        ws.send(pkt(retain ? 0x31 : 0x30, str(topic).concat(Array.from(enc.encode(msg)))));
        return true;
      },
      wake: function () { if (!closed && ws && ws.readyState === 3) { retry = 0; connect(); } },
      close: function () {
        closed = true; up = false; clearInterval(ping); clearTimeout(timer);
        try { ws.send(new Uint8Array([0xE0, 0])); ws.close(); } catch (e) {}
      },
    };
  }

  function store(v) {
    try {
      if (v === undefined) return localStorage.getItem(STORE_KEY);
      if (v === null) localStorage.removeItem(STORE_KEY); else localStorage.setItem(STORE_KEY, v);
    } catch (e) { return null; }
  }
  function randomId() {
    var a = new Uint8Array(8); crypto.getRandomValues(a);
    return Array.from(a, function (b) { return (b % 36).toString(36); }).join('');
  }
  var topicOf = function (id) { return 'clipproto/' + id; };

  window.ClipRemote = {
    BROKER: BROKER, KEYS: KEYS, ID_RE: ID_RE, makeMqtt: makeMqtt, topicOf: topicOf,
    // The pairing code saved in this browser, if the remote is turned on.
    id: function () { var v = store(); return ID_RE.test(v || '') ? v : null; },
    newId: function () { var v = randomId(); store(v); return v; },
    off: function () { store(null); },
    // Where the phone goes. The offline gallery file sets CLIP_PROTO_ORIGIN
    // (it's opened from disk, so it has no web address of its own).
    remoteUrl: function (id) {
      var base = /^https?:$/.test(location.protocol) ? location.origin : (window.CLIP_PROTO_ORIGIN || '');
      return base + '/remote#' + id;
    },

    // Listen for the phone. onKey([key, code, keyCode], name); onState('up' | 'down').
    listen: function (opts) {
      var id = opts.id || this.id();
      if (!id) return null;
      var tv = topicOf(id) + '/tv';
      var m = makeMqtt({
        url: BROKER,
        clientId: 'tv-' + Math.random().toString(36).slice(2, 12),
        subs: [topicOf(id) + '/keys'],
        will: { topic: tv, msg: 'off' },
        onState: function (s) {
          if (s === 'up') m.publish(tv, 'on', true);
          if (opts.onState) opts.onState(s);
        },
        onMessage: function (t, msg) { var k = KEYS[msg]; if (k && opts.onKey) opts.onKey(k, msg); },
      });
      var off = function () { m.publish(tv, 'off', true); };
      window.addEventListener('pagehide', off);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) m.wake(); });
      return {
        stop: function () { off(); window.removeEventListener('pagehide', off); setTimeout(function () { m.close(); }, 150); },
      };
    },

    // Press a key in a window, as a real key press would arrive.
    press: function (k, win) {
      win = win || window;
      ['keydown', 'keyup'].forEach(function (type) {
        var target = win.document.activeElement && win.document.activeElement !== win.document.body ? win.document.activeElement : win;
        target.dispatchEvent(new win.KeyboardEvent(type, { key: k[0], code: k[1], keyCode: k[2], which: k[2], bubbles: true, cancelable: true }));
      });
    },
  };
})();
