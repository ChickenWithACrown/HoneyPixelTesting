const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
require('dotenv').config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

// Firebase Admin Setup with environment variables
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 10000;
const webhookURL = process.env.DISCORD_WEBHOOK_URL;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// In-memory fallback for anonymous users
const inMemoryDonations = {};

// Stripe Webhook - must come BEFORE express.json()
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error("⚠️ Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { uid, email, discord, amount } = session.metadata || {};

    console.log(`✅ Stripe checkout.session.completed for ${email || "Guest"} / $${amount}`);

    if (uid && session.payment_status === "paid") {
      try {
        const donationRef = db.ref(`donations/${uid}`);
        const snapshot = await donationRef.once("value");

        snapshot.forEach(childSnap => {
          const d = childSnap.val();
          if (d.amount == amount && d.discord === discord && !d.confirmed) {
            donationRef.child(childSnap.key).update({ confirmed: true });
            sendWebhook("✅ Stripe Donation Confirmed", `**User:** \`${discord}\`\n**Amount:** $${amount}\n**Email:** ${email}`);
          }
        });
      } catch (dbError) {
        console.error("❌ Firebase update error:", dbError);
      }
    } else {
      await sendWebhook("✅ Stripe Donation Confirmed (Guest)", `**User:** \`${discord || "Unknown"}\`\n**Amount:** $${amount}`);
    }
  }

  res.sendStatus(200);
});

// Must come after raw parser
app.use(express.json());
app.use("/image", express.static(path.join(__dirname, "image")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/donate", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "donate.html"));
});

// Discord embed helper
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

// POST: /donation-initiate (used for Discord + message prompt)
app.post("/donation-initiate", async (req, res) => {
  const { discord, amount, message = "", idToken } = req.body;

  if (!discord || !amount) {
    return res.status(400).json({ error: "Missing required fields." });
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
    inMemoryDonations[donationId] = { discord, amount, message, timestamp };
    await sendWebhook("💚 New Donation (Guest)", `**User:** \`${discord}\`\n**Amount:** $${amount}`);
    return res.json({ success: true, id: donationId });
  }
});

// POST: /create-stripe-session
app.post("/create-stripe-session", async (req, res) => {
  const { amount, discord, message = "", idToken } = req.body;

  if (!amount || !discord) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let uid = null;
  let email = null;

  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
      email = decoded.email;
    } catch (err) {
      console.warn("⚠️ Invalid or expired Firebase token. Proceeding as guest.");
    }
  }

  try {
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
      metadata: { uid: uid || "", email: email || "", discord, amount, message },
      mode: "payment",
      success_url: "https://honeypixelmc.com/donate.html?success=true",
      cancel_url: "https://honeypixelmc.com/donate.html?canceled=true",
    });

    if (uid) {
      const donationId = Date.now().toString();
      await db.ref(`donations/${uid}/${donationId}`).set({
        discord, amount, message, email, confirmed: false, via: "stripe", timestamp: Date.now(),
      });
    }

    await sendWebhook("💚 Stripe Donation Started", `**User:** \`${discord}\`\n**Amount:** $${amount}${email ? `\n**Email:** ${email}` : ""}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({ error: "Stripe session creation failed" });
  }
});

// PayPal Webhook
app.post("/paypal-webhook", async (req, res) => {
  const event = req.body;

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = event.resource.amount.value;

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

// Endpoints to securely provide API keys to frontend
app.get('/get-paypal-client-id', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID_DONATE });
});

app.get('/get-stripe-key', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// Endpoint to securely provide Firebase config
app.get('/get-firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server running at https://honeypixelmc.com on port ${PORT}`);
});
