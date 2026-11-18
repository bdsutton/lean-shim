import Mathlib.Algebra.BigOperators.Group.Finset.Basic
import Mathlib.Tactic.Ring

-- Theorem. The sum of the first n natural numbers equals
-- n * (n + 1) / 2.
theorem sum_first_n (n : ℕ) :
    (∑ k ∈ Finset.range (n + 1), k) =
      n * (n + 1) / 2 := by
  -- We'll prove that 2 * \sum_{k=1}^n = n * (n + 1).
  suffices 2 * (∑ k ∈ Finset.range (n + 1), k) = n * (n + 1)          by omega
  -- The proof is by induction.
  induction n with
  | zero =>
    -- Base case: If n = 0, then both the sum and n * (n + 1) equal
    -- 0.
    have : 2 * (∑ k ∈ Finset.range 1, k) = 0                          := by simp
    have : 0 * (0 + 1) = 0                                            := by norm_num
    .                                                                 norm_num [Finset.sum_range_succ]
  | succ n ih =>
    -- Induction step: Suppose that the statement has been proved
    -- for the sum of the first n naturals, and consider the sum of
    -- the first n + 1. Peeling off the last term in the sum gives
    --   2 * \sum_{k=1}^{n+1} k = 2 * \sum_{k=1}^n k + 2 * (n + 1).
    have : 2 * (∑ k ∈ Finset.range ((n + 1) + 1), k)
           = 2 * (∑ k ∈ Finset.range (n + 1), k) + 2 * (n + 1)        := by rw [Finset.sum_range_succ]; ring
    -- By the induction hypothesis, the remaining sigma sum can be
    -- expressed in closed form:
    have : 2 * (∑ k ∈ Finset.range ((n + 1) + 1), k)
           = n * (n + 1) + 2 * (n + 1)                                := by rw [this, ih]
    -- The rest is simplification.
    .                                                                 rw [this]; ring
