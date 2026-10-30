// tests/setup/whatsapp-on.js — WhatsApp is off by default in production (WHATSAPP_ENABLED unset). The suite keeps its
// WhatsApp coverage by switching it on for every test file; tests/router/whatsapp-switch.test.js sets it off itself.
"use strict";

process.env.WHATSAPP_ENABLED = "true";
