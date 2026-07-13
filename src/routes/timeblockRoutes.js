import { Router } from "express";

import {
  createTimeBlock,
  listTimeBlocks,
  updateTimeBlock,
  deleteTimeBlock,
} from "../controllers/timeblockController.js";
import { authenticate } from "../middleware/auth.js";
import { validateTimeBlockCreate } from "../validators/timeblockValidators.js";

const router = Router();
router.use(authenticate);

router.post("/", validateTimeBlockCreate, createTimeBlock);
router.get("/", listTimeBlocks);
router.patch("/:id", updateTimeBlock);
router.delete("/:id", deleteTimeBlock);

export default router;
