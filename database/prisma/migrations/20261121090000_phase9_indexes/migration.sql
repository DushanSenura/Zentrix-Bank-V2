-- CreateIndex
CREATE INDEX "Account_productId_idx" ON "Account"("productId");

-- CreateIndex
CREATE INDEX "AccountApplication_customerId_idx" ON "AccountApplication"("customerId");

-- CreateIndex
CREATE INDEX "AccountApplication_productId_idx" ON "AccountApplication"("productId");

-- CreateIndex
CREATE INDEX "FixedDepositClosureRequest_fixedDepositId_idx" ON "FixedDepositClosureRequest"("fixedDepositId");

-- CreateIndex
CREATE INDEX "FixedDepositRenewal_fixedDepositId_idx" ON "FixedDepositRenewal"("fixedDepositId");

-- CreateIndex
CREATE INDEX "LoanPayment_loanId_idx" ON "LoanPayment"("loanId");

-- CreateIndex
CREATE INDEX "PaymentAuthorization_paymentId_idx" ON "PaymentAuthorization"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentInstruction_status_postedAt_idx" ON "PaymentInstruction"("status", "postedAt");

-- CreateIndex
CREATE INDEX "PaymentInstruction_initiatorId_status_postedAt_idx" ON "PaymentInstruction"("initiatorId", "status", "postedAt");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_idx" ON "SecurityEvent"("userId");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

