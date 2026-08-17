import { Router } from "express";

import { getAppraisal } from "../controllers/appraisalController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", getAppraisal);

export default router;
