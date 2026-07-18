// auth-gate.js — 모든 앱 페이지가 <head>에 포함하는 로그인 게이트.
//   서버가 이미 /api 를 401 로 막지만(실질 보안), 미로그인 사용자가 빈 화면/오류를 보지 않도록
//   즉시 /login 으로 유도한다. 로그인 상태면 window.__cloverUser 에 사용자 정보를 채운다.
(function(){
  if (location.pathname === '/login' || location.pathname === '/login.html') return;
  var next = encodeURIComponent(location.pathname + location.search);
  fetch('/api/auth?action=me', { cache: 'no-store', credentials: 'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.authed && d.user) { window.__cloverUser = d.user; try { window.dispatchEvent(new CustomEvent('clover-auth', { detail: d.user })); } catch(e){} }
      else { location.replace('/login?next=' + next); }
    })
    .catch(function(){ /* 네트워크 오류 시 리다이렉트하지 않음(오프라인 PWA 등) — 서버 게이트가 최종 방어 */ });
})();
