/**
 * CloudVTurb SmartPlayer SDK
 * Suporte a <vturb-smartplayer> custom element, iframes responsivos,
 * injeção de capa instantânea e Call to Action fora do vídeo (outside_video).
 */
(function() {
  if (window.__cloudvturb_sdk_loaded) return;
  window.__cloudvturb_sdk_loaded = true;

  function initPlayers() {
    var smartElements = document.querySelectorAll('vturb-smartplayer:not([data-initialized])');
    smartElements.forEach(function(el) {
      el.setAttribute('data-initialized', 'true');
      var vidId = el.getAttribute('id') || '';
      vidId = vidId.replace(/^vid[-_]/, '');
      if (!vidId) return;

      var placeholder = el.querySelector('.vturb-player-placeholder');
      var isVertical = el.getAttribute('data-vertical') === 'true' || (placeholder && placeholder.style.padding && placeholder.style.padding.includes('177'));
      if (isVertical) {
        el.setAttribute('data-vertical', 'true');
        el.style.maxWidth = window.innerWidth <= 450 ? '100%' : '400px';
        el.style.margin = '0 auto';
        el.style.display = 'block';
      }

      var posterUrl = el.getAttribute('data-poster') || (placeholder && placeholder.getAttribute('data-poster'));
      if (placeholder && posterUrl && !placeholder.querySelector('.thumbnail-image')) {
        var img = document.createElement('img');
        img.className = 'thumbnail-image';
        img.src = posterUrl;
        img.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;z-index:1;';
        placeholder.appendChild(img);
      }

      if (placeholder && !placeholder.querySelector('iframe')) {
        var origin = el.getAttribute('data-host') || window.location.origin;
        var ifr = document.createElement('iframe');
        ifr.id = 'ifr_' + vidId;
        var ifrSrc = origin + '/player?id=' + encodeURIComponent(vidId);
        if (posterUrl) ifrSrc += '&poster=' + encodeURIComponent(posterUrl);
        ifr.src = ifrSrc;
        ifr.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
        ifr.setAttribute('allow', 'autoplay; fullscreen');
        ifr.setAttribute('loading', 'lazy');
        ifr.setAttribute('allowfullscreen', 'true');
        placeholder.appendChild(ifr);
      }
    });
  }

  window.addEventListener('resize', function() {
    var verticals = document.querySelectorAll('vturb-smartplayer[data-vertical="true"]');
    verticals.forEach(function(el) {
      el.style.maxWidth = window.innerWidth <= 450 ? '100%' : '400px';
    });
  });

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
    if (event.data.type === 'vturb_pitch_revealed' || event.data.type === 'vturb_cta_show') {
      var pitchElements = document.querySelectorAll('.vturb-pitch, [data-vturb-pitch], .delay, [data-delay], .esconder, [data-esconder]');
      pitchElements.forEach(function(p) {
        p.style.setProperty('display', 'block', 'important');
      });
      if (event.data.cta && event.data.cta.position === 'outside') {
        var ctaId = 'vturb_outside_cta_' + (event.data.videoId || 'default');
        if (!document.getElementById(ctaId)) {
          var targetEl = document.getElementById('vid-' + event.data.videoId) || document.querySelector('vturb-smartplayer');
          if (targetEl) {
            var ctaWrap = document.createElement('div');
            ctaWrap.id = ctaId;
            ctaWrap.className = 'vturb-outside-call-to-action';
            var maxW = targetEl.style.maxWidth && targetEl.style.maxWidth !== 'none' ? targetEl.style.maxWidth : '400px';
            ctaWrap.style.cssText = 'margin:16px auto 0;width:100%;max-width:' + maxW + ';text-align:center;box-sizing:border-box;';
            var btn = document.createElement('a');
            btn.href = event.data.cta.url || '#';
            if (event.data.cta.openInNewTab !== false) btn.target = '_blank';
            btn.rel = 'noopener noreferrer';
            var btnColor = event.data.cta.color || '#00cd3c';
            btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;padding:15px 24px;border-radius:12px;font-family:Inter,-apple-system,sans-serif;font-weight:700;font-size:18px;letter-spacing:0.5px;text-decoration:none;text-transform:uppercase;background:' + btnColor + ';color:#ffffff;animation:vturbCtaPulse 1.8s infinite ease-in-out;box-shadow:0 10px 25px -5px ' + btnColor + '80;';
            btn.textContent = event.data.cta.text || '';
            ctaWrap.appendChild(btn);
            if (event.data.cta.subtext) {
              var sub = document.createElement('div');
              sub.style.cssText = 'margin-top:8px;font-size:12px;color:#a1a1aa;display:flex;align-items:center;justify-content:center;gap:6px;';
              sub.textContent = event.data.cta.subtext;
              ctaWrap.appendChild(sub);
            }
            if (!document.getElementById('vturb-cta-pulse-style')) {
              var st = document.createElement('style');
              st.id = 'vturb-cta-pulse-style';
              st.textContent = '@keyframes vturbCtaPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}';
              document.head.appendChild(st);
            }
            targetEl.parentNode.insertBefore(ctaWrap, targetEl.nextSibling);
          }
        }
      }
    }
  });
})();
