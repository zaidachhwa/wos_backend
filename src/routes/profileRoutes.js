import { Router } from "express";

import { updateProfile, changePassword, getIcsToken, regenerateIcsToken } from "../controllers/profileController.js";
import { authenticate } from "../middleware/auth.js";
import { validateProfileUpdate, validateChangePassword } from "../validators/profileValidators.js";

const router = Router();
router.use(authenticate);

router.patch("/", validateProfileUpdate, updateProfile);
router.post("/password", validateChangePassword, changePassword);
router.get("/ics-token", getIcsToken);
router.post("/ics-token", regenerateIcsToken);

export default router;
