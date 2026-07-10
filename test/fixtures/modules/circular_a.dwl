%dw 2.0
import foo from modules::circular_b
fun bar(x) = foo(x)
