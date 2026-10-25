import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
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

  console.log("=== 1. TEST GET SWIPE CARDS ===");
  const res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=3", {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Message:", data.message);
  console.log("Cards received:", data?.data?.cards?.length);
  console.log("Target Gender:", data?.data?.targetGender);
  console.log("Target Religion:", data?.data?.targetReligion);

  if (data?.data?.cards?.length) {
    const card = data.data.cards[0];
    console.log("\nCard 1 details:", {
      userId: card.userId,
      fullName: card.fullName,
      age: card.age,
      gender: card.gender,
      religion: card.religion,
      faith: card.faith,
      ethnicity: card.ethnicity,
      country: card.country,
      distanceKm: card.distanceKm,
      images: card.images,
      sharedInterests: card.sharedInterests,
      sharedCount: card.sharedCount,
      matchScore: card.matchScore,
    });

    const targetUserId = card.userId;

    console.log("\n=== 2. TEST SWIPE ACTION: PASS (CROSS ICON) ===");
    const passRes = await fetch("http://localhost:5001/api/v1/profiles/swipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ action: "pass", targetUserId }),
    });
    console.log("Pass response:", await passRes.json());

    console.log("\n=== 3. TEST SWIPE ACTION: UNDO (PREVIOUS ICON) ===");
    const undoRes = await fetch("http://localhost:5001/api/v1/profiles/swipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ action: "undo" }),
    });
    const undoData = await undoRes.json();
    console.log("Undo response:", {
      status: undoRes.status,
      action: undoData?.data?.action,
      rewoundUserId: undoData?.data?.rewoundUserId,
      restoredFullName: undoData?.data?.card?.fullName,
    });

    console.log("\n=== 4. TEST SWIPE ACTION: LIKE (MAKE FRIEND ICON) ===");
    const likeRes = await fetch("http://localhost:5001/api/v1/profiles/swipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ action: "like", targetUserId }),
    });
    console.log("Like response:", await likeRes.json());
  }

  console.log("\n=== 5. TEST ONBOARDING ALIAS ROUTE ===");
  const onbRes = await fetch("http://localhost:5001/api/v1/onboarding/cards?limit=2", {
    headers: { Authorization: "Bearer " + token },
  });
  const onbData = await onbRes.json();
  console.log("Onboarding /cards status:", onbRes.status, "Cards count:", onbData?.data?.cards?.length);
};

run().catch((e) => console.error("Error:", e));
