%dw 2.0
import * from dw::core::Strings

fun formatName(name) =
    trim(upper(name))

fun validateEmail(email) =
    email contains "@"

fun unusedHelper(x) =
    x + 1
