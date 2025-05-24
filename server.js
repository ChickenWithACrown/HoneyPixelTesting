const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const stripe = require("stripe")("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");
const admin = require("firebase-admin");
const serviceAccount = require("./Key.json");

const app = express();
const PORT = process.env.PORT || 10000;

const webhookURL = "https://discord.com/api/webhooks/1375197337776816160/BAdZrqJED6OQXeQj46zMCcs53o6gh3CfTiYHeOlBNrhH2lESTLEWE2m6CTy-qufoJhn4";

// Firebase Admin Init
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

// Shared webhook function
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

// POST: /donation-initiate (with token validation)
app.post("/donation-initiate", async (req, res) => {
  const { discord, amount, message = "", idToken } = req.body;

  if (!discord || !amount || !idToken) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email;

    const donationId = Date.now().toString();
    const donationData = {
      discord,
      amount,
      message,
      email,
      confirmed: false,
      timestamp: Date.now(),
    };

    await db.ref(`donations/${uid}/${donationId}`).set(donationData);

    const desc = `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}${message ? `\n**Note:** ${message}` : ""}`;
    await sendWebhook("💚 New Donation Started", desc);

    res.json({ success: true, id: donationId });
  } catch (err) {
    console.error("❌ Token verification failed:", err);
    res.status(403).json({ error: "Invalid or expired token" });
  }
});

// POST: /create-stripe-session (with token validation)
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
      discord,
      amount,
      message,
      email,
      confirmed: false,
      via: "stripe",
      timestamp: Date.now(),
    });

    const desc = `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}`;
    await sendWebhook("💚 Stripe Donation Started", desc);

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe/token error:", err);
    res.status(403).json({ error: "Invalid or expired token" });
  }
});

// POST: /paypal-webhook
app.post("/paypal-webhook", async (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

    const snapshot = await db.ref("donations").once("value");
    let found = null;

    snapshot.forEach(userSnap => {
      userSnap.forEach(donationSnap => {
        const donation = donationSnap.val();
        if (donation.amount === amount && !donation.confirmed && !found) {
          found = { uid: userSnap.key, id: donationSnap.key, ...donation };
        }
      });
    });

    if (found) {
      await db.ref(`donations/${found.uid}/${found.id}/confirmed`).set(true);
      await sendWebhook("✅ PayPal Donation Confirmed", `**User:** \`${found.discord}\`\n**Amount:** $${amount}\n**Email:** ${found.email}`);
      console.log(`💸 PayPal confirmed for ${found.email}`);
    } else {
      console.log("⚠️ PayPal payment received but unmatched.");
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 HoneyPixelMC server running on port ${PORT}`);
});
