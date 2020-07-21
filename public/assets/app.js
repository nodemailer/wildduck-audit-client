/* globals document, $, moment, FileReader */
/* eslint no-invalid-this:0 */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        for (let block of document.querySelectorAll('.flash-messages')) {
            block.parentNode.removeChild(block);
        }
    }, 10 * 1000);

    const format = 'YYYY/MM/DD';

    $('input.daterange').each(function () {
        const input = $(this);
        $(this).daterangepicker(
            {
                startDate: $(this).data('start'),
                endDate: $(this).data('end'),
                opens: 'right',
                locale: {
                    format
                }
            },
            function (start, end, label) {
                $(`#${input.data('startTarget')}`).val(start.format(format));
                $(`#${input.data('endTarget')}`).val(end.format(format));
                console.log(
                    input.data('startTarget'),
                    'New date range selected: ' + start.format('YYYY-MM-DD') + ' to ' + end.format('YYYY-MM-DD') + ' (predefined range: ' + label + ')'
                );
            }
        );
    });

    $('input.datepick').daterangepicker({
        singleDatePicker: true,
        opens: 'right',
        locale: {
            format
        }
    });

    for (let elm of document.querySelectorAll('.timestr')) {
        elm.textContent = moment(elm.title).format('ll');
    }

    for (let elm of document.querySelectorAll('.datetimestr')) {
        elm.textContent = moment(elm.title).calendar(null, {
            sameDay: 'HH:MM',
            lastDay: 'D. MMM HH:MM',
            nextDay: 'D. MMM',
            lastWeek: 'D. MMM',
            nextWeek: 'D. MMM',
            sameElse: 'DD/MM/YY'
        });
    }

    for (let elm of document.querySelectorAll('.fulldate')) {
        elm.textContent = moment(elm.title).format('LLL');
    }

    $(function () {
        $('[data-toggle="tooltip"]').tooltip();
    });

    function dropfile(elm, file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            elm.value = (e.target.result || '').trim();
            elm.focus();
            elm.select();
        };
        reader.readAsText(file, 'UTF-8');
    }

    for (let elm of document.querySelectorAll('.droptxt')) {
        elm.addEventListener('dragenter', () => {
            elm.classList.add('dragover');
        });

        elm.addEventListener('dragleave', () => {
            elm.classList.remove('dragover');
        });

        elm.addEventListener('drop', e => {
            e.preventDefault();
            elm.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            dropfile(elm, file);
        });

        elm.addEventListener('click', () => {
            elm.focus();
            elm.select();
        });
    }

    for (let elm of document.querySelectorAll('.click-once')) {
        elm.addEventListener('click', () => {
            setTimeout(() => {
                $(elm).tooltip('dispose');
                elm.parentNode.removeChild(elm);
            }, 100);
        });
    }

    let checkAll = document.getElementById('checkAll');
    if (checkAll) {
        let checkboxList = Array.from(document.querySelectorAll('.checkMessage'));
        let toggleSelectedLinks = Array.from(document.querySelectorAll('.toggle-selected-link'));
        let allSelectedLinks = Array.from(document.querySelectorAll('.all-selected-link'));
        let matchingSelectedLinks = Array.from(document.querySelectorAll('.matching-selected-link'));

        let checkState = () => {
            let someSelected = false;
            let allSelected = false;

            let checkedMessages = [];
            if (checkboxList.length) {
                allSelected = true;

                checkboxList.forEach(cb => {
                    if (cb.checked) {
                        someSelected = true;

                        checkedMessages.push(cb.dataset.message);
                    } else {
                        allSelected = false;
                    }
                });
            }

            if (someSelected) {
                toggleSelectedLinks.forEach(link => {
                    link.removeAttribute('tabindex');
                    link.classList.remove('disabled');
                });
            } else {
                toggleSelectedLinks.forEach(link => {
                    link.setAttribute('tabindex', '-1');
                    link.classList.add('disabled');
                });
            }

            if (allSelected) {
                checkAll.checked = true;
            } else {
                checkAll.checked = false;
            }

            return {
                someSelected,
                allSelected,
                checkedMessages
            };
        };

        let toggleAll = () => {
            checkboxList.forEach(cb => {
                cb.checked = checkAll.checked;
            });
            checkState();
        };

        checkAll.addEventListener('click', () => toggleAll());
        checkAll.addEventListener('change', () => toggleAll());

        checkboxList.forEach(cb => {
            cb.addEventListener('click', () => checkState());
            cb.addEventListener('change', () => checkState());
        });

        if (!checkboxList.length) {
            checkAll.disabled = true;
            checkAll.checked = false;
        }

        toggleSelectedLinks.forEach(link => {
            link.addEventListener('click', e => {
                let { someSelected, checkedMessages } = checkState();
                if (someSelected) {
                    document.getElementById('messagelist').value = JSON.stringify(checkedMessages);
                    $('#downloadMessagesModal').modal('show');
                }
                // ignore click
                e.preventDefault();
            });
        });

        allSelectedLinks.forEach(link => {
            link.addEventListener('click', e => {
                document.getElementById('messagelist').value = 'all';
                $('#downloadMessagesModal').modal('show');
                // ignore click
                e.preventDefault();
            });
        });

        matchingSelectedLinks.forEach(link => {
            link.addEventListener('click', e => {
                document.getElementById('messagelist').value = 'matching';
                $('#downloadMessagesModal').modal('show');
                // ignore click
                e.preventDefault();
            });
        });

        document.getElementById('download-form').addEventListener('submit', () => {
            $('#downloadMessagesModal').modal('hide');
        });

        checkState();
    }
});
