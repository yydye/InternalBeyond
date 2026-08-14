/* Email is assembled after parsing so CDN anti-scraping layers do not replace it with [email protected]. */
/* IB 命名空间迁移：注册到 IB.email（双挂载过渡期，window 行为不变）。 */
(function(NS){
  function revealIBEmails(){
    document.querySelectorAll('.ib-email-link[data-email-user][data-email-domain]').forEach(function(a){
      var address=(a.dataset.emailUser||'')+String.fromCharCode(64)+(a.dataset.emailDomain||'');
      if(!address)return;
      a.textContent=address;
      a.href='mailto:'+address;
      a.setAttribute('aria-label','发送邮件至 '+address);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',revealIBEmails,{once:true});
  else revealIBEmails();
  NS.expose('email', { revealIBEmails: revealIBEmails });
})(window.IB || (window.IB = {}));
