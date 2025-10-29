const { handler } = require("./app/handler");

exports.letterboxd = async (req, res) => {
  try {
    const payload = req && req.body && typeof req.body === "object" ? req.body : {};
    const result = await handler({ source: "gcp.scheduler", ...payload });
    res.status(200).send(result);
  } catch (err) {
    console.error("[letterboxd]", err);
    res.status(500).send(err instanceof Error ? err.message : "Internal Server Error");
  }
};
