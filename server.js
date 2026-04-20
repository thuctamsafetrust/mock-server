const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// Serve the frontend HTML files
app.use(express.static(path.join(__dirname, "public")));

// Mock Database with 3 Users
const usersDB = {
  "jdoe": { username: "jdoe", firstName: "John", lastName: "Doe", badgeId: "98765" },
  "asmith": { username: "asmith", firstName: "Alice", lastName: "Smith", badgeId: "12345" },
  "bwayne": { username: "bwayne", firstName: "Bruce", lastName: "Wayne", badgeId: "None" }
};

// API Endpoint to search for a user
app.get("/api/users/:username", (req, res) => {
  const user = usersDB[req.params.username.toLowerCase()];
  if (user) {
    res.json({ success: true, user });
  } else {
    res.status(404).json({ success: false, message: "User not found." });
  }
});

// Use process.env.PORT for Render, fallback to 4322 locally
const PORT = process.env.PORT || 4322;
app.listen(PORT, () => {
  console.log(`Cloud Web Server running on port ${PORT}`);
  console.log(`Try searching for 'jdoe', 'asmith', or 'bwayne'`);
});
