(function(){
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.nav');
  navToggle.addEventListener('click', () => {
    nav.classList.toggle('open');
  });

  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const target = document.querySelector(link.getAttribute('href'));
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const sections = document.querySelectorAll('section');
  const navLinks = document.querySelectorAll('.nav a');
  window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(section => {
      const sectionTop = section.offsetTop - 70;
      if (pageYOffset >= sectionTop) { current = section.getAttribute('id'); }
    });
    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === '#' + current) { link.classList.add('active'); }
    });
  });

  const form = document.getElementById('apply-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = form.elements['name'].value;
    const email = form.elements['email'].value;
    alert(`Thanks, ${name}!\nWe will contact you at ${email} soon.`);
    form.reset();
  });
})();
