// web/routes/home.js — /app/ home
"use strict";

const { html } = require("../html");

function register(web, { page }) {
  web.get("/", (_req, res) =>
    page(res, {
      title: "الرئيسية",
      nav: "home",
      body: html`<div class="card">
  <h1>AqarChat</h1>
  <p>مخزون وكالتك على الويب: بحث، إضافة وتعديل، واستيراد.</p>
  <p class="muted">Your agency's inventory on the web.</p>
</div>`
    })
  );
};

module.exports = { register };
