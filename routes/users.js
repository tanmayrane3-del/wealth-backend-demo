const express = require("express");
const router = express.Router();
const { createUser, getUserByEmail } = require("../controllers/usersController");

router.post("/", createUser);
router.get("/by-email", getUserByEmail);

module.exports = router;