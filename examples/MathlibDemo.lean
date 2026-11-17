-- Specific imports instead of `import Mathlib`, so the Codespace only downloads the part of Mathlib
-- these need (about 9% of it). After adding an import, run: bash .devcontainer/fetch-mathlib.sh
import Mathlib.Basic.Real.Basic
import Mathlib.Data.Nat.Prime.Infinite
import Mathlib.Algebra.BigOperators.Intervals
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Ring

-- Try it: put the cursor on an empty indented line below and press Ctrl+Alt+L
-- (or click the ✨ button). Press again for a different suggestion.

theorem sum_sq_nonneg (a b : ℝ) : 0 ≤ a ^ 2 + b ^ 2 := by


theorem two_mul_le_sq_add_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by


theorem exists_prime_gt (n : ℕ) : ∃ p, n < p ∧ p.Prime := by


theorem sum_range_id' (n : ℕ) : ∑ i ∈ Finset.range (n + 1), i = n * (n + 1) / 2 := by

