// ===== Мобильное меню =====
const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks');

burger.addEventListener('click', () => {
  navLinks.classList.toggle('nav__links--open');
});

// Закрывать меню при клике на ссылку
navLinks.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('nav__links--open');
  });
});

// ===== Тень у шапки при прокрутке =====
const header = document.getElementById('header');

window.addEventListener('scroll', () => {
  header.classList.toggle('header--scrolled', window.scrollY > 10);
});

// ===== Анимация появления блоков (Intersection Observer) =====
const revealElements = document.querySelectorAll('.reveal');

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('reveal--visible');
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.15 }
);

revealElements.forEach((el) => revealObserver.observe(el));

// ===== Анимация счётчиков =====
const statNumbers = document.querySelectorAll('.stat__number');

function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  const duration = 1800; // мс
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    // easing: easeOutCubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    el.textContent = value.toLocaleString('ru-RU');
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

const statsObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        statsObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.5 }
);

statNumbers.forEach((el) => statsObserver.observe(el));

// ===== Форма на главной: ведём на регистрацию =====
const ctaForm = document.getElementById('ctaForm');
const ctaEmail = document.getElementById('ctaEmail');

ctaForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = ctaEmail.value.trim();
  const target = email
    ? `login.html?mode=register&email=${encodeURIComponent(email)}`
    : 'login.html?mode=register';
  window.location.href = target;
});

// ===== Если пользователь уже вошёл — показываем «Кабинет» =====
window.Nova.request('/api/me')
  .then((data) => {
    if (!data?.user) return;
    const navCta = document.getElementById('navCta');
    navCta.textContent = 'Кабинет';
    navCta.href = 'account.html';
  })
  .catch(() => {});
