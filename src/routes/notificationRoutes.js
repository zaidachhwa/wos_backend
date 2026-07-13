import { Router } from "express";

import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notificationController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", listNotifications);
router.patch("/:id/read", markNotificationRead);
router.post("/mark-all-read", markAllNotificationsRead);

export default router;
