const express = require("express");
const router = express.Router();
const { createUser, getUserByEmail, validateLogin } = require("../controllers/usersController");

router.post("/", createUser);
router.get("/by-email", getUserByEmail);
router.post("/validate-login", validateLogin);

module.exports = router;