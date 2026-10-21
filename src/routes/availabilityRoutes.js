import { Router } from "express";

import { getAvailability } from "../controllers/availabilityController.js";
import { authenticate } from "../middleware/auth.js";

// Visibility is decided per viewer in services/availability.js#visiblePeople
// (team lead / project manager / technical coordinator / admin); anyone else
// simply gets an empty list.
const router = Router();
router.use(authenticate);
router.get("/", getAvailability);

export default router;
