import express from 'express';
import multer from 'multer';
import { cloudinary } from '../config/cloudinary.js';
import { authenticate } from '../middleware/authMiddleware.js';

const router = express.Router();
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const blockedMimeTypes = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-sh',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (blockedMimeTypes.has(file.mimetype)) {
      callback(new Error('This file type is not allowed'));
      return;
    }

    callback(null, true);
  },
});

function receiveSingleFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Files must be 25 MB or smaller' });
      return;
    }

    res.status(400).json({ error: error.message || 'Unable to read the uploaded file' });
  });
}

function uploadBuffer(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        folder: 'wave/attachments',
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    uploadStream.end(file.buffer);
  });
}

function getAttachmentType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

router.post('/', authenticate, receiveSingleFile, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Choose a file to upload' });
  }

  try {
    const uploadedFile = await uploadBuffer(req.file);
    const attachment = {
      type: getAttachmentType(req.file.mimetype),
      url: uploadedFile.secure_url,
      name: req.file.originalname.slice(0, 180),
      size: formatFileSize(uploadedFile.bytes),
      bytes: uploadedFile.bytes,
      mimeType: req.file.mimetype,
      publicId: uploadedFile.public_id,
      resourceType: uploadedFile.resource_type,
    };

    return res.status(201).json({ attachment });
  } catch (error) {
    console.error('Cloudinary upload failed:', error.message);
    return res.status(502).json({ error: 'File upload failed. Please try again.' });
  }
});

export const uploadRoutes = router;
