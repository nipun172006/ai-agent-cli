const nav = document.querySelector(".nav");
const navToggle = document.querySelector(".nav-toggle");
const callbackButtons = document.querySelectorAll("[data-callback]");
const programCards = document.querySelectorAll(".program-card");
const year = document.querySelector("#year");

if (year) {
  year.textContent = new Date().getFullYear();
}

if (nav && navToggle) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

programCards.forEach((card) => {
  card.addEventListener("click", () => {
    programCards.forEach((item) => item.classList.remove("is-active"));
    card.classList.add("is-active");
  });
});

callbackButtons.forEach((button) => {
  button.addEventListener("click", () => {
    alert("Thanks for your interest. An academic advisor would contact you shortly in a real Scaler flow.");
  });
});
