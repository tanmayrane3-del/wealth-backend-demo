// utils/respond.js
const { randomUUID } = require("crypto");

const API_VERSION = "v1"; // you can bump this later

const success = (res, data, statusCode = 200) => {
  res.status(statusCode).json({
    status: "success",
    timestamp: new Date().toISOString(),
    request_id: randomUUID(),
    api_version: API_VERSION,
    data
  });
};

const fail = (res, reason, statusCode = 400) => {
  res.status(statusCode).json({
    status: "fail",
    timestamp: new Date().toISOString(),
    request_id: randomUUID(),
    api_version: API_VERSION,
    reason
  });
};

module.exports = { success, fail };