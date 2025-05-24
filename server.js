const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 10000;

require("dotenv").config(); // optional .env

const webhookURL = process.env.WEBHOOK_URL || "https://discord.com/api/webhooks/1375197337776816160/BAdZrqJED6OQXeQj46zMCcs53o6gh3CfTiYHeOlBNrhH2lESTLEWE2m6CTy-qufoJhn4";

// In-memory donation store
const donations = {};

app.use(express.json());
app.use("/image", express.static(path.join(__dirname, "image")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 🆕 Send webhook
function sendWebhook(title, description, color = 0x00ffcc) {
  const embed = {
    embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
  };

  return fetch(webhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  });
}

// 📥 New donation started
app.post("/donation-initiate", (req, res) => {
  const { discord, amount, message = "" } = req.body;

  if (!discord || !amount) {
    return res.status(400).json({ error: "Missing discord or amount" });
  }

  const id = Date.now().toString();
  donations[id] = { discord, amount, message, timestamp: Date.now(), confirmed: false };

  const description = `**User:** \`${discord}\`\n**Amount:** $${amount}\n${message ? `**Note:** ${message}` : ""}`;
  sendWebhook("💚 New Donation", description)
    .then(() => {
      console.log(`✅ Donation started: ${discord} ($${amount})`);
      res.json({ success: true, id });
    })
    .catch((err) => {
      console.error("❌ Webhook error:", err);
      res.status(500).json({ error: "Webhook failed" });
    });
});

// ✅ Check donation confirmation status
app.get("/donation-status/:id", (req, res) => {
  const donation = donations[req.params.id];
  if (!donation) return res.status(404).json({ error: "Not found" });
  res.json({ confirmed: donation.confirmed });
});

// 🧾 PayPal webhook
app.post("/paypal-webhook", (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

    const matchEntry = Object.entries(donations)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .find(([, d]) => d.amount === amount && !d.confirmed);

    const discord = matchEntry ? matchEntry[1].discord : "Unknown";
    if (matchEntry) donations[matchEntry[0]].confirmed = true;

    const description = `**User:** \`${discord}\`\n**Amount:** $${amount}`;
    sendWebhook("✅ Donation Confirmed via PayPal", description).catch(console.error);

    console.log(`💸 Confirmed donation of $${amount} from ${discord}`);
  } else {
    console.log("📥 Other PayPal event received:", event.event_type);
  }

  res.sendStatus(200);
});

// 🟢 Start
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
