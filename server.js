const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const stripe = require("stripe")("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");
const admin = require("firebase-admin");
const serviceAccount = require("./Key.json");

const app = express();
const PORT = process.env.PORT || 10000;
const webhookURL = "https://discord.com/api/webhooks/1375197337776816160/BAdZrqJED6OQXeQj46zMCcs53o6gh3CfTiYHeOlBNrhH2lESTLEWE2m6CTy-qufoJhn4";

// 🧠 In-memory fallback
const inMemoryDonations = {};

// 🧩 Firebase Init
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://honeypixel-1257f-default-rtdb.firebaseio.com/"
});
const db = admin.database();

app.use(express.json());
app.use("/image", express.static(path.join(__dirname, "image")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 📣 Discord embed
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

// 🎯 Unified donation endpoint (with or without token)
app.post("/donation-initiate", async (req, res) => {
  const { discord, amount, message = "", idToken } = req.body;

  if (!discord || !amount) {
    return res.status(400).json({ error: "Missing discord or amount." });
  }

  const donationId = Date.now().toString();
  const timestamp = Date.now();

  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;
      const email = decoded.email;

      await db.ref(`donations/${uid}/${donationId}`).set({
        discord, amount, message, email, confirmed: false, timestamp
      });

      await sendWebhook("💚 New Donation Started", `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}`);
      return res.json({ success: true, id: donationId });
    } catch (err) {
      console.error("❌ Token error:", err);
      return res.status(403).json({ error: "Invalid token" });
    }
  } else {
    inMemoryDonations[donationId] = { discord, amount, timestamp };
    await sendWebhook("💚 New Donation (Guest)", `**User:** \`${discord}\`\n**Amount:** $${amount}`);
    return res.json({ success: true, id: donationId });
  }
});

// 💳 Stripe Session
app.post("/create-stripe-session", async (req, res) => {
  const { amount, discord, message = "", idToken } = req.body;

  if (!amount || !discord || !idToken) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `HoneyPixel Donation (${discord})`,
            description: message || "Support HoneyPixelMC",
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

    const donationId = Date.now().toString();
    await db.ref(`donations/${uid}/${donationId}`).set({
      discord, amount, message, email, confirmed: false, via: "stripe", timestamp: Date.now(),
    });

    await sendWebhook("💚 Stripe Donation Started", `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe/token error:", err);
    res.status(403).json({ error: "Invalid or expired token" });
  }
});

// 🧾 PayPal Webhook
app.post("/paypal-webhook", async (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

    // 🔍 First check Firebase
    const snapshot = await db.ref("donations").once("value");
    let found = null;

    snapshot.forEach(userSnap => {
      userSnap.forEach(donationSnap => {
        const d = donationSnap.val();
        if (d.amount === amount && !d.confirmed && !found) {
          found = { uid: userSnap.key, id: donationSnap.key, ...d };
        }
      });
    });

    if (found) {
      await db.ref(`donations/${found.uid}/${found.id}/confirmed`).set(true);
      await sendWebhook("✅ PayPal Donation Confirmed", `**User:** \`${found.discord}\`\n**Amount:** $${amount}\n**Email:** ${found.email}`);
    } else {
      // 🧠 Check fallback in-memory
      const match = Object.entries(inMemoryDonations)
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .find(([, d]) => d.amount === amount);

      const fallbackUser = match ? match[1].discord : "Unknown";
      await sendWebhook("✅ PayPal Confirmed (No Token)", `**User:** \`${fallbackUser}\`\n**Amount:** $${amount}`);
    }

    console.log(`💸 PayPal confirmed: $${amount}`);
  }

  res.sendStatus(200);
});

// 🚀 Start server
app.listen(PORT, () => {
  console.log(`✅ Hybrid server running on port ${PORT}`);
});
