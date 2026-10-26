/**
 * CloudVTurb SmartPlayer SDK
 * Suporte a <vturb-smartplayer> custom element e iframes responsivos
 */
(function() {
  if (window.__cloudvturb_sdk_loaded) return;
  window.__cloudvturb_sdk_loaded = true;

  function initPlayers() {
    try {
      if (!document.getElementById('cloudvturb-base-styles')) {
        var st = document.createElement('style');
        st.id = 'cloudvturb-base-styles';
        st.textContent = 'vturb-smartplayer, .vturb-player-placeholder { background-color: #000 !important; background: #000 !important; }';
        document.head.appendChild(st);
      }
    } catch (_) {}

    var smartElements = document.querySelectorAll('vturb-smartplayer:not([data-initialized])');
    smartElements.forEach(function(el) {
      el.setAttribute('data-initialized', 'true');
      var vidId = el.getAttribute('id') || '';
      vidId = vidId.replace(/^vid[-_]/, '');
      if (!vidId) return;

      var placeholder = el.querySelector('.vturb-player-placeholder');
      if (placeholder) {
        placeholder.style.backgroundColor = '#000';
      }
      if (placeholder && !placeholder.querySelector('iframe')) {
        var origin = el.getAttribute('data-host') || window.location.origin;
        var ifr = document.createElement('iframe');
        ifr.id = 'ifr_' + vidId;
        ifr.src = origin + '/player?id=' + encodeURIComponent(vidId);
        ifr.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
        ifr.setAttribute('allow', 'autoplay; fullscreen');
        ifr.setAttribute('loading', 'lazy');
        ifr.setAttribute('allowfullscreen', 'true');
        placeholder.appendChild(ifr);
      }
    });
  }

  if (typeof customElements !== 'undefined' && !customElements.get('vturb-smartplayer')) {
    try {
      class VturbSmartPlayer extends HTMLElement {
        connectedCallback() {
          initPlayers();
        }
      }
      customElements.define('vturb-smartplayer', VturbSmartPlayer);
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlayers);
  } else {
    initPlayers();
  }

  window.addEventListener('message', function(event) {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'vturb_pitch_revealed') {
      var pitchElements = document.querySelectorAll('.vturb-pitch, [data-vturb-pitch]');
      pitchElements.forEach(function(p) {
        p.style.display = 'block';
      });
    }
  });
})();
