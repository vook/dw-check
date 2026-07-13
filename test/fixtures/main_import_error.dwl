%dw 2.0
output json
import badFunction from modules::bad_syntax
import formatName from modules::utils
---
{
    result: badFunction(payload.name),
    name: formatName(payload.name)
}
