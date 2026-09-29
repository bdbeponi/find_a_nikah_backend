import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  listPlans,
  getPlan,
  initiatePayment,
  paymentWebhook,
  getMySubscription,
  cancelMySubscription,
  getMyPayments,
  confirmPaymentDev,
} from "../controllers/billing.controllers.js";

/**
 * The catalogue is public - the pricing screen has to render before anybody
 * signs up, and there is nothing in a plan that is not already on the
 * marketing site.
 */
export const planRouter = Router();
planRouter.route("/").get(listPlans);
planRouter.route("/:slug").get(getPlan);

/**
 * Payments are the one router here that cannot take a blanket guard: the
 * gateway calls the webhook, and a gateway has no session. Its signature check
 * is the whole of its authentication - see verifyWebhookSignature - so every
 * other route on this router names verifyJWT for itself.
 */
export const paymentRouter = Router();
paymentRouter.route("/webhook").post(paymentWebhook);
paymentRouter.route("/initiate").post(verifyJWT, initiatePayment);
paymentRouter.route("/me").get(verifyJWT, getMyPayments);
paymentRouter.route("/:id/confirm").post(verifyJWT, confirmPaymentDev);

export const subscriptionRouter = Router();
subscriptionRouter.use(verifyJWT);
subscriptionRouter.route("/me").get(getMySubscription);
subscriptionRouter.route("/me/cancel").post(cancelMySubscription);
