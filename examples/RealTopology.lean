import Mathlib.Basic.Real.Basic
--import Mathlib.Algebra.Order.Archimedean.Real.Basic
import Mathlib.NumberTheory.Real.Irrational
--import Mathlib.Tactic.Ring
--import Mathlib.Tactic.Linarith
--import Mathlib.Tactic.NormNum
--import Mathlib.Tactic.Positivity
--import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Push
--import Mathlib.Tactic.Tauto
--import Mathlib.Tactic.Common
import Mathlib.Topology.MetricSpace.Basic

open Set

-- Definition. A *neighborhood* of a point x₀ in a
-- metric space S is a set
--   Nᵣ(x₀) = { x ∈ S | dist(x, x₀) < r }
-- for some radius r. Ross requires r > 0, but the
-- usual approach in Lean is to omit this from the
-- definition and instead impose r > 0 in theorems.
def Neighborhood {S} [MetricSpace S]
    (x₀ : S) (r : ℝ) : Set S :=
  { x : S | dist x x₀ < r }

-- Definition. A point x₀ is *interior to* a set E if
-- there exists a neighborhood of positive radius
-- around x₀ that is entirely contained within E.
def IsInteriorTo {S} [MetricSpace S]
    (x₀ : S) (E : Set S) : Prop :=
  ∃ r : ℝ, r > 0 ∧ (Neighborhood x₀ r) ⊆ E

-- Definition. The *interior* of a set E is the set of
-- all its interior points.
def Interior {S} [MetricSpace S] (E : Set S) : Set S :=
  { x : S | IsInteriorTo x E }

-- Theorem. The left endpoint of any closed interval
-- [a, b] is not interior to the interval.
theorem left_endpoint_of_Icc_is_not_interior
    (a : ℝ) (b : ℝ) : ¬(IsInteriorTo a (Icc a b)) := by
