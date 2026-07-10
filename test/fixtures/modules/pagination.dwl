%dw 2.0
fun createPagination(data, pageSize = 10, page = 1) =
    data splitAt ((page - 1) * pageSize)
