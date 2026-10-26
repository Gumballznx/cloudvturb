/**
 * CloudVTurb SmartPlayer SDK
 * Suporte a <vturb-smartplayer> custom element, iframes responsivos,
 * injeção de capa instantânea e Call to Action fora do vídeo (outside_video).
 */
(function() {
  if (window.__cloudvturb_sdk_loaded) return;
  window.__cloudvturb_sdk_loaded = true;

  if (!document.querySelector('link[href*="vturb"]')) {
    try {
      var lk = document.createElement('link');
      lk.rel = 'dns-prefetch';
      lk.href = 'https://api.vturb.com.br';
      document.head.appendChild(lk);
    } catch (_) {}
  }

  function guardIframeReload(ifr) {
    if (!ifr || ifr.__guarded) return;
    ifr.__guarded = true;
    ifr.classList.add('utmify-ignore');
    var currentSrc = ifr.src;
    try {
      Object.defineProperty(ifr, 'src', {
        get: function() { return currentSrc; },
        set: function(newSrc) {
          if (!newSrc || newSrc === currentSrc) return;
          try {
            var oldUrl = new URL(currentSrc, window.location.href);
            var freshUrl = new URL(newSrc, window.location.href);
            if (oldUrl.origin === freshUrl.origin && oldUrl.pathname === freshUrl.pathname) {
              currentSrc = newSrc;
              if (ifr.contentWindow) {
                ifr.contentWindow.postMessage({ type: 'UPDATE_UTMS', url: newSrc }, '*');
              }
              return;
            }
          } catch (_) {}
          currentSrc = newSrc;
          ifr.setAttribute('src', newSrc);
        },
        configurable: true
      });
    } catch (_) {}
  }

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
      var padStyle = (placeholder && placeholder.style.padding) ? placeholder.style.padding : '';
      var hasVerticalPadding = padStyle.includes('177') || padStyle.includes('133') || padStyle.includes('125');
      var isVertical = el.getAttribute('data-vertical') === 'true' || hasVerticalPadding;
      if (isVertical) {
        el.setAttribute('data-vertical', 'true');
        el.style.maxWidth = window.innerWidth <= 450 ? '100%' : '400px';
        el.style.margin = '0 auto';
        el.style.display = 'block';
      }

      function fadeAndRemoveThumbnail(target) {
        var thumbs = (target || placeholder).querySelectorAll('.thumbnail-image');
        thumbs.forEach(function(th) {
          th.style.transition = 'opacity 0.25s ease';
          th.style.opacity = '0';
          setTimeout(function() { if (th && th.parentNode) th.remove(); }, 260);
        });
      }

      var posterUrl = el.getAttribute('data-poster') || (placeholder && placeholder.getAttribute('data-poster'));
      if (placeholder && posterUrl && !placeholder.querySelector('.thumbnail-image') && !placeholder.querySelector('iframe')) {
        var img = document.createElement('img');
        img.className = 'thumbnail-image';
        img.src = posterUrl;
        img.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;z-index:1;';
        placeholder.appendChild(img);
      }

      var existingIfr = placeholder ? placeholder.querySelector('iframe') : null;
      if (existingIfr) {
        guardIframeReload(existingIfr);
        existingIfr.addEventListener('load', function() {
          setTimeout(function() { fadeAndRemoveThumbnail(placeholder); }, 400);
        });
      }

      if (placeholder && !existingIfr) {
        var origin = el.getAttribute('data-host') || window.location.origin;
        var ifr = document.createElement('iframe');
        ifr.id = 'ifr_' + vidId;
        ifr.className = 'utmify-ignore';
        var ifrSrc = origin + '/player?id=' + encodeURIComponent(vidId);
        if (posterUrl) ifrSrc += '&poster=' + encodeURIComponent(posterUrl);
        var pageSearch = window.location.search;
        if (pageSearch && pageSearch.length > 1) {
          var pParams = new URLSearchParams(pageSearch);
          var reservedKeys = ['id', 'preview', 'dash_preview', 'theme', 'token', 'poster', 'resume', 'bar_color', 'smart_autoplay'];
          pParams.forEach(function(val, key) {
            if (!reservedKeys.includes(key.toLowerCase()) && !ifrSrc.includes(key + '=')) {
              ifrSrc += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(val);
            }
          });
        }
        ifr.src = ifrSrc;
        guardIframeReload(ifr);
        ifr.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
        ifr.setAttribute('allow', 'autoplay; fullscreen');
        ifr.setAttribute('allowfullscreen', 'true');
        ifr.addEventListener('load', function() {
          setTimeout(function() { fadeAndRemoveThumbnail(placeholder); }, 400);
        });
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
    if (event.data.type === 'vturb_player_ready' || event.data.type === 'vturb_player_playing' || event.data.source === 'cloudvturb_player') {
      var allThumbs = document.querySelectorAll('.thumbnail-image');
      allThumbs.forEach(function(th) {
        if (th && th.parentNode) th.remove();
      });
    }
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
