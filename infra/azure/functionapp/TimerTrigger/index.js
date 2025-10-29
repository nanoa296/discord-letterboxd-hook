const { handler } = require("../app/handler");

module.exports = async function (context, timer) {
  try {
    const result = await handler({ source: "azure.timer" });
    context.log("[letterboxd]", result);
  } catch (err) {
    context.log.error("[letterboxd] run failed", err);
    throw err;
  }
};
