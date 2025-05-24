const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 10000;

const webhookURL = "https://discord.com/api/webhooks/1375197337776816160/BAdZrqJED6OQXeQj46zMCcs53o6gh3CfTiYHeOlBNrhH2lESTLEWE2m6CTy-qufoJhn4";

// In-memory donation store
const donations = {};

app.use(express.json());

// ✅ Serve static folders
app.use("/image", express.static(path.join(__dirname, "image"))); // <--- Moved here
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 📥 New donation started
app.post("/donation-initiate", (req, res) => {
  const { discord, amount } = req.body;

  if (!discord || !amount) {
    return res.status(400).json({ error: "Missing discord username or amount" });
  }

  const id = Date.now().toString();
  donations[id] = { discord, amount, timestamp: Date.now() };

  const embed = {
    embeds: [
      {
        title: "💚 New Donation",
        description: `**User:** \`${discord}\`\n**Amount:** $${amount}`,
        color: 0x00ffcc,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  fetch(webhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  })
    .then(() => {
      console.log(`✅ Donation started: ${discord} ($${amount})`);
      res.json({ success: true, id });
    })
    .catch((err) => {
      console.error("❌ Webhook error:", err);
      res.status(500).json({ error: "Webhook failed" });
    });
});

// 🧾 PayPal webhook for payment confirmation
app.post("/paypal-webhook", (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

    const matchEntry = Object.entries(donations)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .find(([, d]) => d.amount === amount);

    const discord = matchEntry ? matchEntry[1].discord : "Unknown";

    const embed = {
      embeds: [
        {
          title: "✅ Donation Confirmed via PayPal",
          description: `**User:** \`${discord}\`\n**Amount:** $${amount}`,
          color: 0x00ff00,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    fetch(webhookURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(embed),
    }).catch(console.error);

    console.log(`💸 PayPal confirmed: $${amount} from ${discord}`);
  } else {
    console.log("📥 Non-capture PayPal event received:", event.event_type);
  }

  res.sendStatus(200);
});

// 🟢 Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
