import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { shrink } from "../utils/image.js";

// __dirname setup for ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadFolder = path.join(__dirname, "../../public/upload");
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

/**
 * Multer's own diskStorage writes whatever arrives, byte for byte. A profile
 * photo straight off a phone is routinely 3-5MB and several thousand pixels
 * wide, and the site would then ship that to every visitor.
 *
 * This engine sits in the same place but pushes the file through sharp first,
 * so an oversized upload is shrunk once, here, instead of on every request
 * forever. Controllers still just read `file.filename`, so nothing downstream
 * changes.
 */
const imageStorage = {
  async _handleFile(req, file, cb) {
    try {
      const chunks = [];
      for await (const chunk of file.stream) chunks.push(chunk);

      // shrink decides the format, so the name is built from what came back
      // rather than from what was sent.
      const { buffer, ext } = await shrink(
        Buffer.concat(chunks),
        path.extname(file.originalname).toLowerCase()
      );
      const filename = `${Date.now()}-${uuidv4()}${ext}`;
      const destination = path.join(uploadFolder, filename);

      await fs.promises.writeFile(destination, buffer);
      cb(null, {
        destination: uploadFolder,
        filename,
        path: destination,
        size: buffer.length,
      });
    } catch (err) {
      cb(err);
    }
  },

  _removeFile(req, file, cb) {
    fs.unlink(file.path, cb);
  },
};

const allowedTypes = /jpeg|jpg|png|webp/;

const fileFilter = (req, file, cb) => {
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    cb(null, true);
  } else {
    cb(new Error("Only jpeg, jpg, png and webp image files are allowed!"));
  }
};

export const upload = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter,
});
