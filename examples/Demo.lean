-- Try it: put the cursor on an empty indented line below and press Ctrl+Alt+L
-- (or click the ✨ button). Press again for a different suggestion.

theorem add_comm' (a b : Nat) : a + b = b + a := by


theorem and_swap (p q : Prop) (h : p ∧ q) : q ∧ p := by


theorem length_append (xs ys : List Nat) :
    (xs ++ ys).length = xs.length + ys.length := by

