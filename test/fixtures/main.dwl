%dw 2.0
output json
import formatName, validateEmail from modules::utils
import createPagination from modules::pagination
---
{
    user: formatName(payload.name),
    email: validateEmail(payload.email),
    page: createPagination(payload.items)
}
