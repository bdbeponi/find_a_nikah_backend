import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { upload } from "../middlewares/multer.middlewares.js";
import {
  getMyProfile,
  upsertMyProfile,
  setDiscoverable,
  listEducation,
  addEducation,
  updateEducation,
  removeEducation,
  listProfession,
  addProfession,
  updateProfession,
  removeProfession,
  getFamily,
  saveFamily,
  getPreference,
  savePreference,
  listMyPhotos,
  uploadPhoto,
  setPrimaryPhoto,
  setPhotoVisibility,
  removePhoto,
  submitVerification,
  getMyVerification,
} from "../controllers/profile.controllers.js";

const router = Router();

// Everything under /profile is the signed-in member's own. Applied to the whole
// router so a route added below cannot forget it.
router.use(verifyJWT);

router.route("/me").get(getMyProfile).put(upsertMyProfile);
router.route("/me/discoverable").patch(setDiscoverable);

router.route("/me/education").get(listEducation).post(addEducation);
router.route("/me/education/:id").patch(updateEducation).delete(removeEducation);

router.route("/me/profession").get(listProfession).post(addProfession);
router.route("/me/profession/:id").patch(updateProfession).delete(removeProfession);

router.route("/me/family").get(getFamily).put(saveFamily);
router.route("/me/preference").get(getPreference).put(savePreference);

router
  .route("/me/photos")
  .get(listMyPhotos)
  .post(upload.single("photo"), uploadPhoto);
router.route("/me/photos/:id").patch(setPhotoVisibility).delete(removePhoto);
router.route("/me/photos/:id/primary").patch(setPrimaryPhoto);

router
  .route("/me/verification")
  .get(getMyVerification)
  .post(upload.single("document"), submitVerification);

export default router;
