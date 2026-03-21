const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const {
  getAssets,
  getSummary,
  createAsset,
  updateAsset,
  deleteAsset,
} = require("../controllers/physicalAssetsController");

router.get("/summary", validateSession, getSummary);
router.get("/",        validateSession, getAssets);
router.post("/",       validateSession, createAsset);
router.put("/:id",     validateSession, updateAsset);
router.delete("/:id",  validateSession, deleteAsset);

module.exports = router;
