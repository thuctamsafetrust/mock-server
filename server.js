const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const fetch = require("node-fetch"); // npm install node-fetch@2
const forge = require("node-forge");

const app = express();
app.use(cors());
app.use(express.json());

// --- DIRECTORIES ---
app.use(express.static(path.join(__dirname, "public")));

// Standard server directory structure
const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(dataDir, "uploads");
const certsDir = path.join(dataDir, "certs");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir);

const CERT_INDEX_PATH = path.join(dataDir, "cert-index.json");
if (!fs.existsSync(CERT_INDEX_PATH)) fs.writeFileSync(CERT_INDEX_PATH, "{}");

// --- MOCK DATABASE ---
const usersDB = {
  "jdoe": { username: "jdoe", firstName: "John", lastName: "Doe", badgeId: "98765" },
  "asmith": { username: "asmith", firstName: "Alice", lastName: "Smith", badgeId: "12345" },
  "bwayne": { username: "bwayne", firstName: "Bruce", lastName: "Wayne", badgeId: "None" }
};

app.get("/api/users/:username", (req, res) => {
  const user = usersDB[req.params.username.toLowerCase()];
  if (user) {
    res.json({ success: true, user });
  } else {
    res.status(404).json({ success: false, message: "User not found." });
  }
});

// --- CERTIFICATE PARSING & CACHING ---
let certCache = {};

function parsePKCS12(p12Buffer, passphrase) {
  try {
    const p12Der = forge.util.decode64(p12Buffer.toString("base64"));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase || "");

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

    if (!certBags || !keyBags) throw new Error("Invalid P12: missing cert or key bags");

    const certBag = certBags[forge.pki.oids.certBag]?.[0];
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];

    if (!certBag || !keyBag) throw new Error("Invalid P12: no certificate or key found");

    const cert = forge.pki.certificateToPem(certBag.cert);
    const key = forge.pki.privateKeyToPem(keyBag.key);
    const caList = [];

    if (certBags[forge.pki.oids.certBag]) {
      for (let i = 1; i < certBags[forge.pki.oids.certBag].length; i++) {
        caList.push(forge.pki.certificateToPem(certBags[forge.pki.oids.certBag][i].cert));
      }
    }
    return { cert, key, ca: caList };
  } catch (err) {
    throw new Error(`Failed to parse P12: ${err.message}`);
  }
}

function loadCertIndex() {
  try { return JSON.parse(fs.readFileSync(CERT_INDEX_PATH, "utf8")); } 
  catch { return {}; }
}

function saveCertIndex(index) {
  fs.writeFileSync(CERT_INDEX_PATH, JSON.stringify(index, null, 2));
}

function loadAllCerts() {
  const index = loadCertIndex();
  for (const [hostname, filename] of Object.entries(index)) {
    const certPath = path.join(certsDir, filename);
    if (fs.existsSync(certPath)) {
      try {
        certCache[hostname] = JSON.parse(fs.readFileSync(certPath, "utf8"));
      } catch (err) {}
    }
  }
}
loadAllCerts();

// --- CERTIFICATE UPLOAD ENDPOINTS ---
const upload = multer({ dest: uploadDir, limits: { fileSize: 3 * 1024 * 1024 } });

app.post("/upload-cert", upload.single("p12file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const passphrase = req.body.passphrase || "";
    const hostname = req.body.hostname || "";

    if (!hostname) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Hostname is required" });
    }

    const p12Buffer = fs.readFileSync(req.file.path);

    try {
      const certData = parsePKCS12(p12Buffer, passphrase);
      const certFilename = `${hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}.json`;
      const certPath = path.join(certsDir, certFilename);

      fs.writeFileSync(certPath, JSON.stringify(certData, null, 2));

      const index = loadCertIndex();
      index[hostname] = certFilename;
      saveCertIndex(index);
      certCache[hostname] = certData;
      fs.unlinkSync(req.file.path);

      res.json({ success: true, message: `Certificate for ${hostname} uploaded successfully` });
    } catch (parseErr) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid P12 file or passphrase", details: parseErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

app.get("/check-cert/:hostname", (req, res) => {
  const hostname = req.params.hostname;
  res.json({ exists: hostname in loadCertIndex(), cached: hostname in certCache, hostname });
});

// --- HARDWARE PROXY AGENTS ---
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 1000,
  timeout: 30000
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000
});

function createMtlsAgent(clientCert) {
  return new https.Agent({
    cert: clientCert.cert,
    key: clientCert.key,
    ca: clientCert.ca.length > 0 ? clientCert.ca : undefined,
    rejectUnauthorized: false,
    requestCert: true,
    minVersion: "TLSv1.2",
    keepAlive: true,
    keepAliveMsecs: 1000,
    timeout: 30000,
  });
}

// --- HARDWARE PROXY ENDPOINT ---
let readerBusy = false;

app.post("/api/credential", async (req, res) => {
  if (readerBusy) return res.status(429).json({ error: "Reader busy. Try again." });
  readerBusy = true;

  try {
    const { host, timeout = 5000, mode = "http" } = req.body;
    const url = mode === "http" ? `http://${host}/api/credential` : `https://${host}/api/credential`;

    let agent;
    if (mode === "http") agent = httpAgent;
    else if (mode === "https") agent = httpsAgent;
    else if (mode === "mtls") {
      const clientCert = certCache[host];
      if (!clientCert) {
        readerBusy = false;
        return res.status(400).json({ error: `No client certificate found for host: ${host}` });
      }
      agent = createMtlsAgent(clientCert);
    }

    const fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
      body: JSON.stringify({ action: "read", timeout: Number(timeout) }),
      timeout: timeout + 15000,
      agent,
    };

    console.log(`Forwarding request to hardware: ${url}`);
    const sensorResponse = await fetch(url, fetchOptions);
    const text = await sensorResponse.text();

    if (!sensorResponse.ok) {
      readerBusy = false;
      return res.status(sensorResponse.status).json({ error: text || "Sensor error" });
    }

    if (sensorResponse.status === 204) {
      readerBusy = false;
      return res.status(200).json({ 
        connected: true, 
        status: 204, 
        message: "Reader connected successfully, but no card was detected." 
      });
    }

    try {
      res.json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Invalid response from sensor", raw: text });
    }
  } catch (error) {
    if (error.type === "request-timeout") res.status(504).json({ error: "Sensor timeout" });
    else res.status(500).json({ error: "Proxy failed", message: error.message, code: error.code });
  } finally {
    readerBusy = false;
  }
});

// --- START SERVER ---
const PORT = 4322;
app.listen(PORT, () => {
  console.log(`Cloud Web Server running at http://localhost:${PORT}`);
  console.log(`Try searching for 'jdoe', 'asmith', or 'bwayne'`);
});
