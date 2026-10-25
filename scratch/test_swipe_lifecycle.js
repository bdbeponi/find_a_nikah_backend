import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  const token = jwt.sign(
    {
      _id: "6ac5e6cb9a4c151759932718",
      email: "user@gmail.com",
      role: "member",
      gender: "male",
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "1d" }
  );

  // 1. Fetch 3 cards
  console.log("=== 1. Fetch initial 3 cards ===");
  let res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=3", {
    headers: { Authorization: "Bearer " + token },
  });
  let json = await res.json();
  console.log("Initial cards:", json.data.cards.map(c => c.fullName));
  const firstCard = json.data.cards[0];

  // 2. Pass first card
  console.log(`\n=== 2. Swiping PASS on ${firstCard.fullName} (${firstCard.userId}) ===`);
  let passRes = await fetch("http://localhost:5001/api/v1/profiles/swipe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ action: "pass", targetUserId: firstCard.userId }),
  });
  console.log("Pass result:", (await passRes.json()).message);

  // 3. Fetch cards again -> firstCard should NOT be in deck
  res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=3", {
    headers: { Authorization: "Bearer " + token },
  });
  json = await res.json();
  console.log("Deck after pass:", json.data.cards.map(c => c.fullName));

  // 4. Undo swipe -> firstCard should be restored
  console.log(`\n=== 3. Swiping UNDO to restore ${firstCard.fullName} ===`);
  let undoRes = await fetch("http://localhost:5001/api/v1/profiles/swipe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ action: "undo" }),
  });
  console.log("Undo result:", (await undoRes.json()).message);

  // 5. Fetch cards again -> firstCard should be back at top
  res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=3", {
    headers: { Authorization: "Bearer " + token },
  });
  json = await res.json();
  console.log("Deck after undo:", json.data.cards.map(c => c.fullName));

  await mongoose.disconnect();
};

run().catch(console.error);
