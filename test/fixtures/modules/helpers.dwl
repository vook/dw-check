%dw 2.0
import formatName from modules::utils

fun greetUser(user) =
    "Hello, " ++ formatName(user.name)
