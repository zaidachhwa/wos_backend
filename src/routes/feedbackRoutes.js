import { Router } from "express";

import {
  FEEDBACK_VIEWERS,
  BONUS_REQUEST_VIEWERS,
  submitFeedback,
  listFeedback,
  setFeedbackStatus,
  myBonusRequest,
  submitBonusRequest,
  listBonusRequests,
} from "../controllers/feedbackController.js";
import { authenticate, authorize } from "../middleware/auth.js";

// Anonymous feedback: anyone posts; only admin/HR read.
export const feedbackRouter = Router();
feedbackRouter.use(authenticate);
feedbackRouter.post("/", submitFeedback);
feedbackRouter.get("/", authorize(...FEEDBACK_VIEWERS), listFeedback);
feedbackRouter.patch("/:id", authorize(...FEEDBACK_VIEWERS), setFeedbackStatus);

// Special bonus requests: anyone submits once a month (25th–month end, IST);
// admin/HR/directors read.
export const bonusRequestRouter = Router();
bonusRequestRouter.use(authenticate);
bonusRequestRouter.get("/mine", myBonusRequest);
bonusRequestRouter.post("/", submitBonusRequest);
bonusRequestRouter.get("/", authorize(...BONUS_REQUEST_VIEWERS), listBonusRequests);
