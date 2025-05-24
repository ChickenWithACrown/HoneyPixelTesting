const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const stripe = require("stripe")("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");
const app = express();
const PORT = process.env.PORT || 10000;

const webhookURL = "https://discord.com/api/webhooks/1375197337776816160/BAdZrqJED6OQXeQj46zMCcs53o6gh3CfTiYHeOlBNrhH2lESTLEWE2m6CTy-qufoJhn4"; 
const donations = {}; // memory-based log

app.use(express.json());
app.use("/image", express.static(path.join(__dirname, "image")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 🔗 Shared embed sender
function sendWebhook(title, description, color = 0x00ffcc) {
  const embed = {
    embeds: [{
      title,
      description,
      color,
      timestamp: new Date().toISOString(),
    }],
  };
  return fetch(webhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  });
}

// 📥 Donation Start (requires auth)
app.post("/donation-initiate", (req, res) => {
  const { discord, amount, message = "", uid, email } = req.body;

  if (!discord || !amount || !uid || !email) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const id = Date.now().toString();
  donations[id] = { discord, amount, message, uid, email, timestamp: Date.now(), confirmed: false };

  const desc = `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}${message ? `\n**Note:** ${message}` : ""}`;
  sendWebhook("💚 New Donation Started", desc)
    .then(() => {
      console.log(`✅ Donation started by ${email} ($${amount})`);
      res.json({ success: true, id });
    })
    .catch((err) => {
      console.error("❌ Webhook error:", err);
      res.status(500).json({ error: "Webhook failed" });
    });
});

// 🧾 PayPal Confirmation
app.post("/paypal-webhook", (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

    const matchEntry = Object.entries(donations)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .find(([, d]) => d.amount === amount && !d.confirmed);

    const discord = matchEntry ? matchEntry[1].discord : "Unknown";
    const email = matchEntry ? matchEntry[1].email : "Unknown";

    if (matchEntry) matchEntry[1].confirmed = true;

    const desc = `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}`;
    sendWebhook("✅ PayPal Donation Confirmed", desc).catch(console.error);
    console.log(`💸 PayPal confirmed: $${amount} from ${discord}`);
  } else {
    console.log("📥 Other PayPal event:", event.event_type);
  }

  res.sendStatus(200);
});

// 🧾 Stripe Session Creation
app.post("/create-stripe-session", async (req, res) => {
  const { amount, uid, email, discord, message } = req.body;

  if (!amount || !uid || !email || !discord) {
    return res.status(400).json({ error: "Missing Stripe donation info" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `HoneyPixel Donation (${discord})`,
            description: message || "Thanks for your support!",
          },
          unit_amount: Math.round(parseFloat(amount) * 100),
        },
        quantity: 1,
      }],
      metadata: { uid, email, discord, amount, message },
      mode: "payment",
      success_url: "https://honeypixelmc.com/donate-success",
      cancel_url: "https://honeypixelmc.com/donate-cancel",
    });

    const id = Date.now().toString();
    donations[id] = { uid, email, discord, amount, message, timestamp: Date.now(), confirmed: false };

    const desc = `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}${message ? `\n**Note:** ${message}` : ""}`;
    sendWebhook("💚 Stripe Donation Started", desc).catch(console.error);

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe error:", err);
    res.status(500).json({ error: "Stripe failed" });
  }
});

// 🟢 Server start
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
