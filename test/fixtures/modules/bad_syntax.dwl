%dw 2.0
import * from dw::core::Strings

fun badFunction(name) =
    {name: }  // syntax error: missing value after colon

fun formatGreeting(greeting) =
    upper(greeting)
