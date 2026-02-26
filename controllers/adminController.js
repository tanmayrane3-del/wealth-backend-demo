// In-memory queue stats — resets on server restart (sufficient for personal monitoring)
let queueStats = { pending: 0, lastReported: null };

const getSmsQueue = (req, res) => {
    res.json({ status: "success", data: queueStats });
};

const updateSmsQueue = (req, res) => {
    const { pending } = req.body;
    if (typeof pending !== "number") {
        return res.status(400).json({ status: "error", reason: "pending must be a number" });
    }
    queueStats = { pending, lastReported: new Date().toISOString() };
    res.json({ status: "success" });
};

module.exports = { getSmsQueue, updateSmsQueue };
