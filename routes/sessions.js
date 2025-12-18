const express = require("express");
const router = express.Router();
const {
  login,
  validateSession,
  logout
} = require("../controllers/sessionsController");

router.post("/login", login);
router.post("/validate", validateSession);
router.post("/logout", logout);

module.exports = router;